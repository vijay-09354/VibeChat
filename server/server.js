
import express from "express";
import cors from "cors";
import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { Server } from "socket.io";

import { PrismaClient } from "./generated/prisma/client.ts";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT) || 5000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = path.join(__dirname, "uploads");

if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
}

const adapter = new PrismaBetterSqlite3({
    url: process.env.DATABASE_URL
});

const prisma = new PrismaClient({ adapter });

// HTTP server is shared by Express and Socket.IO.
const httpServer = createServer(app);

const io = new Server(httpServer, {
    cors: {
        origin: true,
        methods: ["GET", "POST", "DELETE"]
    }
});

// Active calls are stored in server memory.
const activeCalls = new Map();

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use("/uploads", express.static(uploadsDir));

// =====================================
// AUTHENTICATION
// =====================================

function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers.authorization;

        if (!authHeader?.startsWith("Bearer ")) {
            return res.status(401).json({
                message: "Authentication required."
            });
        }

        if (!process.env.JWT_SECRET) {
            return res.status(500).json({
                message: "JWT secret is not configured."
            });
        }

        req.user = jwt.verify(
            authHeader.split(" ")[1],
            process.env.JWT_SECRET
        );

        next();
    } catch {
        return res.status(401).json({
            message: "Invalid or expired token."
        });
    }
}

// =====================================
// SOCKET.IO AUTHENTICATION
// =====================================

io.use((socket, next) => {
    try {
        const token = socket.handshake.auth?.token;

        if (!token || !process.env.JWT_SECRET) {
            return next(new Error("Authentication required."));
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);

        if (!decoded.userId) {
            return next(new Error("Invalid authentication token."));
        }

        socket.data.userId = Number(decoded.userId);
        socket.data.username = decoded.username || "VibeChat User";

        next();
    } catch {
        next(new Error("Invalid or expired token."));
    }
});

function getPeerId(call, userId) {
    if (call.callerId === userId) return call.calleeId;
    if (call.calleeId === userId) return call.callerId;
    return null;
}

function userIsBusy(userId) {
    for (const call of activeCalls.values()) {
        if (call.callerId === userId || call.calleeId === userId) {
            return true;
        }
    }
    return false;
}

function sendCallError(socket, message) {
    socket.emit("call:error", { message });
}

// =====================================
// CALLING + WEBRTC SIGNALING
// =====================================

io.on("connection", (socket) => {
    const userId = socket.data.userId;
    const userRoom = `user:${userId}`;

    socket.join(userRoom);

    console.log(`Calling service connected: user ${userId}`);

    // Caller requests a voice or video call.
    socket.on("call:invite", async (payload = {}) => {
        try {
            const toUserId = Number(payload.toUserId);
            const conversationId = Number(payload.conversationId);
            const callId = String(payload.callId || "");
            const type = payload.type;

            if (
                !Number.isInteger(toUserId) ||
                toUserId <= 0 ||
                toUserId === userId ||
                !Number.isInteger(conversationId) ||
                conversationId <= 0 ||
                !callId ||
                callId.length > 100 ||
                !["voice", "video"].includes(type)
            ) {
                return sendCallError(socket, "Invalid call details.");
            }

            if (activeCalls.has(callId)) {
                return sendCallError(socket, "Call already exists.");
            }

            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId }
            });

            if (
                !conversation ||
                ![conversation.starterId, conversation.receiverId].includes(userId) ||
                ![conversation.starterId, conversation.receiverId].includes(toUserId)
            ) {
                return sendCallError(socket, "You cannot call this user.");
            }

            const recipient = await prisma.user.findUnique({
                where: { id: toUserId },
                select: { id: true, username: true }
            });

            if (!recipient) {
                return sendCallError(socket, "User not found.");
            }

            if (!io.sockets.adapter.rooms.has(`user:${toUserId}`)) {
                return sendCallError(socket, "This user is offline.");
            }

            if (userIsBusy(userId) || userIsBusy(toUserId)) {
                return sendCallError(socket, "One of the users is already in a call.");
            }

            const call = {
                callId,
                callerId: userId,
                calleeId: toUserId,
                conversationId,
                type,
                status: "ringing"
            };

            activeCalls.set(callId, call);

            io.to(`user:${toUserId}`).emit("call:incoming", {
                callId,
                fromUserId: userId,
                fromUsername: socket.data.username,
                conversationId,
                type
            });

            socket.emit("call:ringing", { callId });
        } catch (error) {
            console.error("Call invite error:", error);
            sendCallError(socket, "Could not start the call.");
        }
    });

    // Recipient accepts the incoming call.
    socket.on("call:accept", (payload = {}) => {
        const call = activeCalls.get(String(payload.callId || ""));

        if (!call || call.calleeId !== userId || call.status !== "ringing") {
            return;
        }

        call.status = "accepted";

        io.to(`user:${call.callerId}`).emit("call:accepted", {
            callId: call.callId,
            fromUserId: userId
        });

        socket.emit("call:connected", { callId: call.callId });
    });

    // Recipient rejects the call.
    socket.on("call:reject", (payload = {}) => {
        const call = activeCalls.get(String(payload.callId || ""));

        if (!call || call.calleeId !== userId || call.status !== "ringing") {
            return;
        }

        activeCalls.delete(call.callId);

        io.to(`user:${call.callerId}`).emit("call:rejected", {
            callId: call.callId,
            fromUserId: userId
        });
    });

    // Relay WebRTC signaling only between participants of an accepted call.
    function relaySignal(eventName, payload, fieldName) {
        if (!payload || typeof payload !== "object") return;

        const call = activeCalls.get(String(payload.callId || ""));

        if (!call || call.status !== "accepted") return;

        const peerId = getPeerId(call, userId);
        const signalData = payload[fieldName];

        if (!peerId || !signalData || typeof signalData !== "object") {
            return;
        }

        io.to(`user:${peerId}`).emit(eventName, {
            callId: call.callId,
            fromUserId: userId,
            [fieldName]: signalData
        });
    }

    socket.on("webrtc:offer", (payload) => {
        relaySignal("webrtc:offer", payload, "offer");
    });

    socket.on("webrtc:answer", (payload) => {
        relaySignal("webrtc:answer", payload, "answer");
    });

    socket.on("webrtc:ice-candidate", (payload) => {
        relaySignal("webrtc:ice-candidate", payload, "candidate");
    });

    // Either participant can end an active call.
    socket.on("call:end", (payload = {}) => {
        const call = activeCalls.get(String(payload.callId || ""));

        if (!call) return;

        const peerId = getPeerId(call, userId);

        if (!peerId) return;

        activeCalls.delete(call.callId);

        io.to(`user:${peerId}`).emit("call:ended", {
            callId: call.callId,
            fromUserId: userId
        });

        socket.emit("call:ended", {
            callId: call.callId,
            fromUserId: userId
        });
    });

    socket.on("disconnect", () => {
        // End this user's calls when their socket disconnects.
        for (const [callId, call] of activeCalls.entries()) {
            const peerId = getPeerId(call, userId);

            if (peerId) {
                activeCalls.delete(callId);

                io.to(`user:${peerId}`).emit("call:ended", {
                    callId,
                    fromUserId: userId
                });
            }
        }

        console.log(`Calling service disconnected: user ${userId}`);
    });
});

// =====================================
// HOME + DATABASE TEST
// =====================================

app.get("/", (req, res) => {
    res.json({
        message: "Welcome to VibeChat API 🚀",
        status: "Server is running successfully!"
    });
});

app.get("/api/test-db", async (req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ message: "Database connected successfully! ✅" });
    } catch (error) {
        console.error("Database error:", error);
        res.status(500).json({
            message: "Database connection failed ❌"
        });
    }
});

// =====================================
// REGISTER
// =====================================

app.post("/api/auth/register", async (req, res) => {
    try {
        const { username, email, password } = req.body;

        if (!username || !email || !password) {
            return res.status(400).json({
                message: "Username, email and password are required."
            });
        }

        const cleanUsername = String(username).trim();
        const cleanEmail = String(email).trim().toLowerCase();

        if (cleanUsername.length < 3) {
            return res.status(400).json({
                message: "Username must contain at least 3 characters."
            });
        }

        if (String(password).length < 8) {
            return res.status(400).json({
                message: "Password must contain at least 8 characters."
            });
        }

        const existingEmail = await prisma.user.findUnique({
            where: { email: cleanEmail }
        });

        if (existingEmail) {
            return res.status(409).json({
                message: "Email is already registered."
            });
        }

        const existingUsername = await prisma.user.findUnique({
            where: { username: cleanUsername }
        });

        if (existingUsername) {
            return res.status(409).json({
                message: "Username is already taken."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const user = await prisma.user.create({
            data: {
                username: cleanUsername,
                email: cleanEmail,
                passwordHash
            }
        });

        res.status(201).json({
            message: "Account created successfully! 🎉",
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });
    } catch (error) {
        console.error("Registration error:", error);
        res.status(500).json({
            message: "Something went wrong while creating your account."
        });
    }
});

// =====================================
// LOGIN
// =====================================

app.post("/api/auth/login", async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({
                message: "Email and password are required."
            });
        }

        const cleanEmail = String(email).trim().toLowerCase();

        const user = await prisma.user.findUnique({
            where: { email: cleanEmail }
        });

        if (!user) {
            return res.status(401).json({
                message: "Invalid email or password."
            });
        }

        const passwordCorrect = await bcrypt.compare(
            password,
            user.passwordHash
        );

        if (!passwordCorrect) {
            return res.status(401).json({
                message: "Invalid email or password."
            });
        }

        if (!process.env.JWT_SECRET) {
            return res.status(500).json({
                message: "JWT secret is not configured."
            });
        }

        const token = jwt.sign(
            {
                userId: user.id,
                username: user.username
            },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        res.json({
            message: "Login successful! 🎉",
            token,
            user: {
                id: user.id,
                username: user.username,
                email: user.email
            }
        });
    } catch (error) {
        console.error("Login error:", error);
        res.status(500).json({
            message: "Something went wrong during login."
        });
    }
});

// =====================================
// CURRENT USER
// =====================================

app.get("/api/auth/me", authenticateToken, async (req, res) => {
    try {
        const user = await prisma.user.findUnique({
            where: { id: Number(req.user.userId) },
            select: {
                id: true,
                username: true,
                email: true,
                createdAt: true
            }
        });

        if (!user) {
            return res.status(404).json({ message: "User not found." });
        }

        res.json({ user });
    } catch (error) {
        console.error("Current user error:", error);
        res.status(500).json({
            message: "Could not get current user."
        });
    }
});

// =====================================
// SEARCH USERS
// =====================================

app.get("/api/users/search", authenticateToken, async (req, res) => {
    try {
        const query = String(req.query.q || "").trim();

        if (!query) return res.json({ users: [] });

        const users = await prisma.user.findMany({
            where: {
                AND: [
                    { id: { not: Number(req.user.userId) } },
                    {
                        OR: [
                            { username: { contains: query } },
                            { email: { contains: query } }
                        ]
                    }
                ]
            },
            select: {
                id: true,
                username: true,
                email: true
            },
            take: 20
        });

        res.json({ users });
    } catch (error) {
        console.error("Search users error:", error);
        res.status(500).json({
            message: "Could not search users."
        });
    }
});

// =====================================
// CREATE / GET CHAT
// =====================================

app.post("/api/chats", authenticateToken, async (req, res) => {
    try {
        const senderId = Number(req.user.userId);
        const receiverId = Number(req.body.receiverId);

        if (!Number.isInteger(receiverId) || receiverId <= 0) {
            return res.status(400).json({
                message: "receiverId is required."
            });
        }

        if (senderId === receiverId) {
            return res.status(400).json({
                message: "You cannot chat with yourself."
            });
        }

        const receiver = await prisma.user.findUnique({
            where: { id: receiverId },
            select: {
                id: true,
                username: true,
                email: true
            }
        });

        if (!receiver) {
            return res.status(404).json({ message: "User not found." });
        }

        let conversation = await prisma.conversation.findFirst({
            where: {
                OR: [
                    { starterId: senderId, receiverId },
                    { starterId: receiverId, receiverId: senderId }
                ]
            },
            include: {
                starter: {
                    select: { id: true, username: true, email: true }
                },
                receiver: {
                    select: { id: true, username: true, email: true }
                }
            }
        });

        if (!conversation) {
            conversation = await prisma.conversation.create({
                data: { starterId: senderId, receiverId },
                include: {
                    starter: {
                        select: { id: true, username: true, email: true }
                    },
                    receiver: {
                        select: { id: true, username: true, email: true }
                    }
                }
            });
        }

        res.json({
            message: "Chat ready! 💬",
            conversation
        });
    } catch (error) {
        console.error("Create chat error:", error);
        res.status(500).json({ message: "Could not create chat." });
    }
});

// =====================================
// GET ALL CHATS
// =====================================

app.get("/api/chats", authenticateToken, async (req, res) => {
    try {
        const userId = Number(req.user.userId);

        const conversations = await prisma.conversation.findMany({
            where: {
                OR: [
                    { starterId: userId },
                    { receiverId: userId }
                ]
            },
            include: {
                starter: {
                    select: { id: true, username: true, email: true }
                },
                receiver: {
                    select: { id: true, username: true, email: true }
                },
                messages: {
                    orderBy: { createdAt: "desc" },
                    take: 1,
                    include: {
                        sender: {
                            select: { id: true, username: true }
                        }
                    }
                }
            },
            orderBy: { updatedAt: "desc" }
        });

        const chats = conversations.map((conversation) => ({
            id: conversation.id,
            createdAt: conversation.createdAt,
            updatedAt: conversation.updatedAt,
            user: conversation.starterId === userId
                ? conversation.receiver
                : conversation.starter,
            lastMessage: conversation.messages[0] || null
        }));

        res.json({ chats });
    } catch (error) {
        console.error("Get chats error:", error);
        res.status(500).json({ message: "Could not get chats." });
    }
});

// =====================================
// GET MESSAGES
// =====================================

app.get(
    "/api/chats/:conversationId/messages",
    authenticateToken,
    async (req, res) => {
        try {
            const conversationId = Number(req.params.conversationId);
            const userId = Number(req.user.userId);

            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId }
            });

            if (!conversation) {
                return res.status(404).json({
                    message: "Conversation not found."
                });
            }

            if (
                conversation.starterId !== userId &&
                conversation.receiverId !== userId
            ) {
                return res.status(403).json({
                    message: "You are not part of this conversation."
                });
            }

            const messages = await prisma.message.findMany({
                where: { conversationId },
                orderBy: { createdAt: "asc" },
                include: {
                    sender: {
                        select: { id: true, username: true }
                    }
                }
            });

            res.json({ messages });
        } catch (error) {
            console.error("Get messages error:", error);
            res.status(500).json({
                message: "Could not get messages."
            });
        }
    }
);

// =====================================
// SEND TEXT MESSAGE
// =====================================

app.post(
    "/api/chats/:conversationId/messages",
    authenticateToken,
    async (req, res) => {
        try {
            const conversationId = Number(req.params.conversationId);
            const userId = Number(req.user.userId);
            const content = String(req.body.content || "").trim();

            if (!content) {
                return res.status(400).json({
                    message: "Message cannot be empty."
                });
            }

            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId }
            });

            if (!conversation) {
                return res.status(404).json({
                    message: "Conversation not found."
                });
            }

            if (
                conversation.starterId !== userId &&
                conversation.receiverId !== userId
            ) {
                return res.status(403).json({
                    message: "You are not part of this conversation."
                });
            }

            const message = await prisma.message.create({
                data: {
                    conversationId,
                    senderId: userId,
                    content
                },
                include: {
                    sender: {
                        select: { id: true, username: true }
                    }
                }
            });

            res.status(201).json({
                message: "Message sent! 📨",
                data: message
            });
        } catch (error) {
            console.error("Send message error:", error);
            res.status(500).json({
                message: "Could not send message."
            });
        }
    }
);

// =====================================
// MEDIA UPLOAD
// =====================================

const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsDir),
    filename: (_req, file, cb) => {
        const extension = path.extname(file.originalname);
        const baseName = path.basename(file.originalname, extension)
            .replace(/[^a-zA-Z0-9-_]/g, "_");

        const uniqueName =
            `${Date.now()}-${Math.round(Math.random() * 1e9)}-${baseName}${extension}`;

        cb(null, uniqueName);
    }
});

const allowedMimeTypes = [
    "image/jpeg", "image/png", "image/gif", "image/webp",
    "video/mp4", "video/webm", "video/quicktime",
    "audio/mpeg", "audio/mp3", "audio/wav", "audio/ogg",
    "application/pdf", "text/plain",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation"
];

const upload = multer({
    storage,
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
        if (allowedMimeTypes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error("This file type is not supported."));
        }
    }
});

app.post(
    "/api/chats/:conversationId/media",
    authenticateToken,
    upload.single("media"),
    async (req, res) => {
        try {
            const conversationId = Number(req.params.conversationId);
            const userId = Number(req.user.userId);

            if (!req.file) {
                return res.status(400).json({
                    message: "Please select a file."
                });
            }

            const conversation = await prisma.conversation.findUnique({
                where: { id: conversationId }
            });

            if (
                !conversation ||
                (
                    conversation.starterId !== userId &&
                    conversation.receiverId !== userId
                )
            ) {
                fs.unlinkSync(req.file.path);

                return res.status(conversation ? 403 : 404).json({
                    message: conversation
                        ? "You are not part of this conversation."
                        : "Conversation not found."
                });
            }

            let mediaType = "file";

            if (req.file.mimetype.startsWith("image/")) {
                mediaType = "image";
            } else if (req.file.mimetype.startsWith("video/")) {
                mediaType = "video";
            } else if (req.file.mimetype.startsWith("audio/")) {
                mediaType = "audio";
            }

            const message = await prisma.message.create({
                data: {
                    conversationId,
                    senderId: userId,
                    content: String(req.body.content || "").trim(),
                    mediaUrl: `/uploads/${req.file.filename}`,
                    mediaType,
                    fileName: req.file.originalname
                },
                include: {
                    sender: {
                        select: { id: true, username: true }
                    }
                }
            });

            res.status(201).json({
                message: "Media sent successfully! 📎",
                data: message
            });
        } catch (error) {
            console.error("Media upload error:", error);

            if (req.file && fs.existsSync(req.file.path)) {
                fs.unlinkSync(req.file.path);
            }

            res.status(500).json({
                message: error.message || "Could not upload media."
            });
        }
    }
);

// =====================================
// DELETE MESSAGE
// =====================================

app.delete(
    "/api/messages/:messageId",
    authenticateToken,
    async (req, res) => {
        try {
            const messageId = Number(req.params.messageId);
            const userId = Number(req.user.userId);

            const message = await prisma.message.findUnique({
                where: { id: messageId }
            });

            if (!message) {
                return res.status(404).json({
                    message: "Message not found."
                });
            }

            if (message.senderId !== userId) {
                return res.status(403).json({
                    message: "You can delete only your own messages."
                });
            }

            if (message.mediaUrl) {
                const filename = path.basename(message.mediaUrl);
                const filePath = path.join(uploadsDir, filename);

                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                }
            }

            await prisma.message.delete({
                where: { id: messageId }
            });

            res.json({
                message: "Message deleted successfully."
            });
        } catch (error) {
            console.error("Delete message error:", error);
            res.status(500).json({
                message: "Could not delete message."
            });
        }
    }
);

// =====================================
// ERROR HANDLERS
// =====================================

app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);

    if (err instanceof multer.MulterError) {
        if (err.code === "LIMIT_FILE_SIZE") {
            return res.status(400).json({
                message: "File is too large. Maximum size is 25 MB."
            });
        }

        return res.status(400).json({ message: err.message });
    }

    if (err) {
        return res.status(400).json({
            message: err.message || "Request failed."
        });
    }

    next();
});

app.use((err, _req, res, _next) => {
    console.error("Server error:", err);

    if (!res.headersSent) {
        res.status(500).json({
            message: "Internal server error."
        });
    }
});

// =====================================
// START SERVER
// =====================================

httpServer.listen(PORT, () => {
    console.log(`VibeChat server running at http://localhost:${PORT}`);
    console.log(`Media uploads available at http://localhost:${PORT}/uploads`);
    console.log("Socket.IO calling service is ready 📞");
});
