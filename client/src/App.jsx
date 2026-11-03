import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import "./App.css";

const API_URL = "http://localhost:5000";

function App() {
  const [mode, setMode] = useState("login");

  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  const [user, setUser] = useState(() => {
    try {
      const saved = localStorage.getItem("user");
      return saved ? JSON.parse(saved) : null;
    } catch {
      return null;
    }
  });

  const [token, setToken] = useState(
    localStorage.getItem("token") || ""
  );

  const [activePage, setActivePage] = useState("dashboard");

  const [chats, setChats] = useState([]);
  const [selectedChat, setSelectedChat] = useState(null);
  const [messages, setMessages] = useState([]);

  const [newMessage, setNewMessage] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  const [loading, setLoading] = useState(false);
  const [loadingChats, setLoadingChats] = useState(false);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const [sendingMessage, setSendingMessage] = useState(false);
  const [uploadingMedia, setUploadingMedia] = useState(false);
  const [attachmentMenu, setAttachmentMenu] = useState(false);

  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const [favorites, setFavorites] = useState(() => {
    try {
      return (
        JSON.parse(
          localStorage.getItem("vibechat_favorites")
        ) || []
      );
    } catch {
      return [];
    }
  });

  const [darkMode, setDarkMode] = useState(
    localStorage.getItem("vibechat_dark") === "true"
  );

  const [notifications, setNotifications] =
    useState(true);

  const [callType, setCallType] = useState(null);
  const [callStatus, setCallStatus] = useState("");
  const [incomingCall, setIncomingCall] = useState(null);
  const [callPeer, setCallPeer] = useState(null);
  const [localStream, setLocalStream] = useState(null);
  const [remoteStream, setRemoteStream] = useState(null);
  const [callMuted, setCallMuted] = useState(false);
  const [cameraOff, setCameraOff] = useState(false);

  const socketRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const callIdRef = useRef(null);
  const remoteUserIdRef = useRef(null);
  const pendingIceCandidatesRef = useRef([]);
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const localStreamRef = useRef(null);
  const remoteStreamRef = useRef(null);

  const fileInputRef = useRef(null);

  useEffect(() => {
    document.body.className = darkMode
      ? "dark-mode"
      : "";

    localStorage.setItem(
      "vibechat_dark",
      darkMode
    );
  }, [darkMode]);

  useEffect(() => {
    localStorage.setItem(
      "vibechat_favorites",
      JSON.stringify(favorites)
    );
  }, [favorites]);

  useEffect(() => {
    if (localVideoRef.current && localStream) {
      localVideoRef.current.srcObject = localStream;
      localVideoRef.current.play?.().catch(() => {});
    }
  }, [localStream, callType]);

  useEffect(() => {
    if (remoteVideoRef.current && remoteStream) {
      remoteVideoRef.current.srcObject = remoteStream;
      remoteVideoRef.current.play?.().catch(() => {});
    }
  }, [remoteStream, callType]);

  function resetCallState() {
    if (peerConnectionRef.current) {
      peerConnectionRef.current.ontrack = null;
      peerConnectionRef.current.onicecandidate = null;
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }

    if (localStream) {
      localStream.getTracks().forEach((track) => track.stop());
    }
    if (remoteStream) {
      remoteStream.getTracks().forEach((track) => track.stop());
    }

    // The refs are authoritative inside asynchronous WebRTC callbacks.
    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }
    if (remoteStreamRef.current) {
      remoteStreamRef.current.getTracks().forEach((track) => track.stop());
      remoteStreamRef.current = null;
    }

    pendingIceCandidatesRef.current = [];
    callIdRef.current = null;
    remoteUserIdRef.current = null;
    setLocalStream(null);
    setRemoteStream(null);
    setCallType(null);
    setCallStatus("");
    setIncomingCall(null);
    setCallPeer(null);
    setCallMuted(false);
    setCameraOff(false);
  }

  // Refs keep stream access current inside socket/WebRTC event callbacks.

  function createPeerConnection(remoteUserId) {
    if (peerConnectionRef.current) {
      return peerConnectionRef.current;
    }

    const pc = new RTCPeerConnection({
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    });

    peerConnectionRef.current = pc;

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => {
        pc.addTrack(track, localStreamRef.current);
      });
    }

    pc.onicecandidate = (event) => {
      if (!event.candidate || !socketRef.current || !callIdRef.current) return;
      socketRef.current.emit("webrtc:ice-candidate", {
        callId: callIdRef.current,
        toUserId: Number(remoteUserId),
        candidate: event.candidate,
      });
    };

    pc.ontrack = (event) => {
      const stream = event.streams?.[0];
      if (stream) {
        remoteStreamRef.current = stream;
        setRemoteStream(stream);
      }
    };

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "connected") {
        setCallStatus("Connected");
      } else if (["failed", "disconnected"].includes(pc.connectionState)) {
        setCallStatus("Connection interrupted. Trying to reconnect...");
      }
    };

    return pc;
  }

  async function applyPendingIceCandidates() {
    const pc = peerConnectionRef.current;
    if (!pc?.remoteDescription) return;

    const candidates = pendingIceCandidatesRef.current;
    pendingIceCandidatesRef.current = [];
    for (const candidate of candidates) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.warn("Could not apply queued ICE candidate:", err);
      }
    }
  }

  useEffect(() => {
    if (!token || !user?.id) return undefined;

    const socket = io(API_URL, {
      auth: { token },
      reconnection: true,
      reconnectionAttempts: 8,
      timeout: 10000,
    });
    socketRef.current = socket;

    socket.on("connect_error", (err) => {
      console.warn("VibeChat call signaling connection failed:", err.message);
    });

    socket.on("call:incoming", (data) => {
      if (!data?.callId) return;
      if (callIdRef.current && callIdRef.current !== data.callId) {
        socket.emit("call:reject", { callId: data.callId });
        return;
      }

      callIdRef.current = data.callId;
      remoteUserIdRef.current = Number(data.fromUserId);
      setIncomingCall(data);
      setCallPeer({
        id: Number(data.fromUserId),
        username: data.fromUsername || "VibeChat user",
        email: "",
      });
      setCallType(data.type === "video" ? "video" : "voice");
      setCallStatus("Incoming call");
    });

    socket.on("call:ringing", (data) => {
      if (!data?.callId || data.callId === callIdRef.current) {
        setCallStatus("Ringing… waiting for answer");
      }
    });

    socket.on("call:accepted", async (data) => {
      if (data?.callId && data.callId !== callIdRef.current) return;
      try {
        setCallStatus("Connecting…");
        const pc = createPeerConnection(remoteUserIdRef.current);
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit("webrtc:offer", {
          callId: callIdRef.current,
          toUserId: Number(remoteUserIdRef.current),
          offer: pc.localDescription,
        });
      } catch (err) {
        console.error("Could not create WebRTC offer:", err);
        setError("Could not start the call. Check microphone/camera permissions and try again.");
        socket.emit("call:end", { callId: callIdRef.current });
        resetCallState();
      }
    });

    socket.on("call:connected", () => {
      setCallStatus("Connecting…");
    });

    socket.on("webrtc:offer", async (data) => {
      if (!data?.offer || (data.callId && data.callId !== callIdRef.current)) return;
      try {
        if (data.fromUserId) remoteUserIdRef.current = Number(data.fromUserId);
        const pc = createPeerConnection(remoteUserIdRef.current);
        await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
        await applyPendingIceCandidates();
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit("webrtc:answer", {
          callId: callIdRef.current,
          toUserId: Number(remoteUserIdRef.current),
          answer: pc.localDescription,
        });
        setCallStatus("Connecting…");
      } catch (err) {
        console.error("Could not answer WebRTC offer:", err);
        setError("Could not connect the call. Please end the call and try again.");
      }
    });

    socket.on("webrtc:answer", async (data) => {
      if (!data?.answer || (data.callId && data.callId !== callIdRef.current)) return;
      try {
        const pc = peerConnectionRef.current;
        if (!pc) return;
        await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
        await applyPendingIceCandidates();
      } catch (err) {
        console.error("Could not apply WebRTC answer:", err);
        setError("Could not finish connecting the call. Please try again.");
      }
    });

    socket.on("webrtc:ice-candidate", async (data) => {
      if (!data?.candidate || (data.callId && data.callId !== callIdRef.current)) return;
      try {
        if (data.fromUserId) remoteUserIdRef.current = Number(data.fromUserId);
        const pc = peerConnectionRef.current;
        if (pc?.remoteDescription) {
          await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
        } else {
          pendingIceCandidatesRef.current.push(data.candidate);
        }
      } catch (err) {
        console.warn("Could not add ICE candidate:", err);
      }
    });

    socket.on("call:rejected", (data) => {
      if (data?.callId && data.callId !== callIdRef.current) return;
      resetCallState();
      showNotice("Call was declined.");
    });

    socket.on("call:ended", (data) => {
      if (data?.callId && data.callId !== callIdRef.current) return;
      const wasInCall = Boolean(callIdRef.current);
      resetCallState();
      if (wasInCall) showNotice("Call ended.");
    });

    socket.on("call:error", (data) => {
      const message = data?.message || "Unable to start or continue this call.";
      setError(message);
      resetCallState();
    });

    return () => {
      socket.removeAllListeners();
      socket.disconnect();
      if (socketRef.current === socket) socketRef.current = null;
      if (peerConnectionRef.current) {
        peerConnectionRef.current.close();
        peerConnectionRef.current = null;
      }
      if (localStreamRef.current) {
        localStreamRef.current.getTracks().forEach((track) => track.stop());
        localStreamRef.current = null;
      }
      if (remoteStreamRef.current) {
        remoteStreamRef.current.getTracks().forEach((track) => track.stop());
        remoteStreamRef.current = null;
      }
    };
    // Socket lifecycle follows the authenticated session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, user?.id]);

  async function apiRequest(
    endpoint,
    options = {}
  ) {
    const currentToken =
      token || localStorage.getItem("token");

    const headers = {
      ...(options.headers || {}),
    };

    if (
      !(options.body instanceof FormData)
    ) {
      headers["Content-Type"] =
        "application/json";
    }

    if (currentToken) {
      headers.Authorization =
        `Bearer ${currentToken}`;
    }

    let response;

    try {
      response = await fetch(
        API_URL + endpoint,
        {
          ...options,
          headers,
        }
      );
    } catch {
      throw new Error(
        "Backend connect nahi ho raha. server.js check karo."
      );
    }

    let data = {};

    try {
      data = await response.json();
    } catch {
      data = {};
    }

    if (!response.ok) {
      throw new Error(
        data.message ||
          `Request failed (${response.status})`
      );
    }

    return data;
  }

  useEffect(() => {
    if (!token) return;

    async function checkUser() {
      try {
        const data =
          await apiRequest(
            "/api/auth/me"
          );

        setUser(data.user);

        localStorage.setItem(
          "user",
          JSON.stringify(data.user)
        );
      } catch {
        localStorage.removeItem("token");
        localStorage.removeItem("user");

        setToken("");
        setUser(null);
      }
    }

    checkUser();
  }, [token]);

  useEffect(() => {
    if (!user || !token) return;

    loadChats();
  }, [user, token]);

  async function loadChats() {
    try {
      setLoadingChats(true);
      setError("");

      const data =
        await apiRequest("/api/chats");

      setChats(data.chats || []);
    } catch (err) {
      console.error(err);
      setError(err.message);
    } finally {
      setLoadingChats(false);
    }
  }

  async function handleSubmit(e) {
    e.preventDefault();

    setLoading(true);
    setError("");
    setNotice("");

    try {
      const endpoint =
        mode === "login"
          ? "/api/auth/login"
          : "/api/auth/register";

      const body =
        mode === "login"
          ? {
              email: email.trim(),
              password,
            }
          : {
              username:
                username.trim(),
              email: email.trim(),
              password,
            };

      const data =
        await apiRequest(
          endpoint,
          {
            method: "POST",
            body: JSON.stringify(body),
          }
        );

      if (mode === "login") {
        localStorage.setItem(
          "token",
          data.token
        );

        localStorage.setItem(
          "user",
          JSON.stringify(data.user)
        );

        setToken(data.token);
        setUser(data.user);

        setActivePage("dashboard");

        setEmail("");
        setPassword("");

        setNotice(
          "Login successful 🎉"
        );
      } else {
        setNotice(
          "Account created successfully 🎉 Please login."
        );

        setMode("login");
        setUsername("");
        setPassword("");
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");

    setToken("");
    setUser(null);

    setChats([]);
    setSelectedChat(null);
    setMessages([]);

    setActivePage("dashboard");

    setEmail("");
    setPassword("");
    setUsername("");
  }

  async function searchUsers(value) {
    setSearchQuery(value);

    if (!value.trim()) {
      setSearchResults([]);
      return;
    }

    try {
      const data =
        await apiRequest(
          `/api/users/search?q=${encodeURIComponent(
            value.trim()
          )}`
        );

      setSearchResults(
        data.users || []
      );
    } catch {
      setSearchResults([]);
    }
  }

  async function startNewChat(
    userToChat
  ) {
    try {
      setError("");

      const data =
        await apiRequest(
          "/api/chats",
          {
            method: "POST",
            body: JSON.stringify({
              receiverId:
                userToChat.id,
            }),
          }
        );

      await loadChats();

      const conversation =
        data.conversation;

      const otherUser =
        Number(
          conversation.starterId
        ) === Number(user.id)
          ? conversation.receiver
          : conversation.starter;

      const chat = {
        id: conversation.id,
        user: otherUser,
        lastMessage: null,
      };

      setSelectedChat(chat);

      setSearchQuery("");
      setSearchResults([]);

      setActivePage("messages");

      await loadMessages(
        conversation.id
      );
    } catch (err) {
      setError(err.message);
    }
  }

  async function openChat(chat) {
    setSelectedChat(chat);
    setActivePage("messages");

    await loadMessages(chat.id);
  }

  async function loadMessages(
    conversationId
  ) {
    try {
      setLoadingMessages(true);

      const data =
        await apiRequest(
          `/api/chats/${conversationId}/messages`
        );

      setMessages(
        data.messages || []
      );
    } catch (err) {
      setMessages([]);
      setError(err.message);
    } finally {
      setLoadingMessages(false);
    }
  }

  async function sendMessage() {
    const content =
      newMessage.trim();

    if (
      !content ||
      !selectedChat ||
      sendingMessage
    ) {
      return;
    }

    try {
      setSendingMessage(true);

      const data =
        await apiRequest(
          `/api/chats/${selectedChat.id}/messages`,
          {
            method: "POST",

            body: JSON.stringify({
              content,
            }),
          }
        );

      setMessages(
        (current) => [
          ...current,
          data.data,
        ]
      );

      setNewMessage("");

      await loadChats();
    } catch (err) {
      setError(err.message);
    } finally {
      setSendingMessage(false);
    }
  }

  // =====================================
  // MEDIA UPLOAD
  // =====================================

  function openFilePicker() {
    if (!selectedChat) {
      showNotice(
        "First select a chat."
      );

      return;
    }

    setAttachmentMenu((current) => !current);
  }

  function chooseAttachment(type) {
    if (!fileInputRef.current) return;

    const acceptMap = {
      media: "image/*,video/*",
      audio: "audio/*",
      document:
        ".pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx",
    };

    fileInputRef.current.accept =
      acceptMap[type] || acceptMap.media;

    setAttachmentMenu(false);
    fileInputRef.current.click();
  }

  async function handleFileSelected(
    event
  ) {
    const file =
      event.target.files?.[0];

    event.target.value = "";

    if (!file || !selectedChat) {
      return;
    }

    const maxSize =
      25 * 1024 * 1024;

    if (file.size > maxSize) {
      setError(
        "File is too large. Maximum size is 25 MB."
      );

      return;
    }

    try {
      setUploadingMedia(true);
      setError("");

      const formData =
        new FormData();

      formData.append(
        "media",
        file
      );

      const data =
        await apiRequest(
          `/api/chats/${selectedChat.id}/media`,
          {
            method: "POST",
            body: formData,
          }
        );

      setMessages(
        (current) => [
          ...current,
          data.data,
        ]
      );

      await loadChats();

      showNotice(
        "Media sent successfully 📎"
      );
    } catch (err) {
      setError(err.message);
    } finally {
      setUploadingMedia(false);
    }
  }

  function getOtherUser(chat) {
    return (
      chat?.user || {
        id: 0,
        username: "Unknown User",
        email: "",
      }
    );
  }

  function getInitials(
    name = ""
  ) {
    return name
      .split(" ")
      .map((x) => x[0])
      .join("")
      .slice(0, 2)
      .toUpperCase();
  }

  const avatarColors = [
    "#00a884",
    "#7c3aed",
    "#e91e63",
    "#2196f3",
    "#ff9800",
    "#009688",
  ];

  function getAvatarColor(
    id = 0
  ) {
    return avatarColors[
      Number(id || 0) %
        avatarColors.length
    ];
  }

  function isFavorite(id) {
    return favorites.includes(
      Number(id)
    );
  }

  function toggleFavorite(id) {
    const numericId =
      Number(id);

    setFavorites(
      (current) =>
        current.includes(
          numericId
        )
          ? current.filter(
              (x) =>
                x !== numericId
            )
          : [
              ...current,
              numericId,
            ]
    );
  }

  function showNotice(text) {
    setNotice(text);

    setTimeout(() => {
      setNotice("");
    }, 2500);
  }

  function handleVoice() {
    showNotice(
      "Voice message feature coming next 🎤"
    );
  }

  async function startCall(type) {
    if (!selectedChat?.id) {
      showNotice("Open a conversation before calling.");
      return;
    }
    if (!socketRef.current?.connected) {
      setError("Call service is not connected yet. Please wait a moment and try again.");
      return;
    }
    if (callIdRef.current) {
      showNotice("A call is already active.");
      return;
    }

    const other = getOtherUser(selectedChat);
    try {
      setError("");
      setCallType(type);
      setCallPeer(other);
      setCallStatus("Requesting microphone and camera permission…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video",
      });
      localStreamRef.current = stream;
      setLocalStream(stream);

      const callId = (globalThis.crypto?.randomUUID?.() || `call-${Date.now()}-${Math.random().toString(16).slice(2)}`);
      callIdRef.current = callId;
      remoteUserIdRef.current = Number(other.id);
      setCallStatus("Calling…");

      socketRef.current.emit("call:invite", {
        toUserId: Number(other.id),
        conversationId: selectedChat.id,
        callId,
        type,
      });
    } catch (err) {
      console.error("Could not access call media:", err);
      resetCallState();
      setError(
        err?.name === "NotAllowedError"
          ? "Microphone/camera permission was denied. Allow access in your browser and try again."
          : err?.name === "NotFoundError"
          ? "No suitable microphone or camera was found on this device."
          : "Could not start the call. Check your microphone/camera and try again."
      );
    }
  }

  async function acceptIncomingCall() {
    if (!incomingCall || !socketRef.current?.connected) return;
    try {
      setError("");
      setCallStatus("Requesting microphone and camera permission…");
      const type = incomingCall.type === "video" ? "video" : "voice";
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === "video",
      });
      localStreamRef.current = stream;
      setLocalStream(stream);
      callIdRef.current = incomingCall.callId;
      remoteUserIdRef.current = Number(incomingCall.fromUserId);
      createPeerConnection(remoteUserIdRef.current);
      socketRef.current.emit("call:accept", { callId: incomingCall.callId });
      setIncomingCall(null);
      setCallStatus("Connecting…");
    } catch (err) {
      console.error("Could not accept call:", err);
      socketRef.current?.emit("call:reject", { callId: incomingCall.callId });
      resetCallState();
      setError(
        err?.name === "NotAllowedError"
          ? "Microphone/camera permission was denied, so the call could not be answered."
          : "Could not answer the call. Check your microphone/camera and try again."
      );
    }
  }

  function rejectIncomingCall() {
    if (incomingCall && socketRef.current?.connected) {
      socketRef.current.emit("call:reject", { callId: incomingCall.callId });
    }
    resetCallState();
  }

  function closeCall() {
    const callId = callIdRef.current;
    if (callId && socketRef.current?.connected) {
      socketRef.current.emit("call:end", { callId });
    }
    resetCallState();
  }

  function toggleCallMute() {
    const nextMuted = !callMuted;
    localStreamRef.current?.getAudioTracks().forEach((track) => {
      track.enabled = !nextMuted;
    });
    setCallMuted(nextMuted);
  }

  function toggleCallCamera() {
    const nextOff = !cameraOff;
    localStreamRef.current?.getVideoTracks().forEach((track) => {
      track.enabled = !nextOff;
    });
    setCameraOff(nextOff);
  }

  function getMediaUrl(
    mediaUrl
  ) {
    if (!mediaUrl) return "";

    return mediaUrl.startsWith(
      "http"
    )
      ? mediaUrl
      : API_URL + mediaUrl;
  }

  function renderMedia(message) {
    if (!message.mediaUrl) {
      return null;
    }

    const url =
      getMediaUrl(
        message.mediaUrl
      );

    if (
      message.mediaType ===
      "image"
    ) {
      return (
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="media-link"
        >
          <img
            src={url}
            alt={
              message.fileName ||
              "Shared image"
            }
            className="chat-image"
          />
        </a>
      );
    }

    if (
      message.mediaType ===
      "video"
    ) {
      return (
        <video
          className="chat-video"
          controls
          src={url}
        />
      );
    }

    if (
      message.mediaType ===
      "audio"
    ) {
      return (
        <audio
          className="chat-audio"
          controls
          src={url}
        />
      );
    }

    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="chat-file"
      >
        📄
        <span>
          {message.fileName ||
            "Download file"}
        </span>
      </a>
    );
  }

  if (!user) {
    return (
      <div className="auth-page">
        <div className="auth-card">

          <div className="auth-logo">
            VC
          </div>

          <h1>VibeChat</h1>

          <p className="auth-subtitle">
            {mode === "login"
              ? "Connect • Chat • Vibe"
              : "Create your VibeChat account"}
          </p>

          <form
            onSubmit={
              handleSubmit
            }
          >
            {mode ===
              "register" && (
              <input
                type="text"
                placeholder="Username"
                value={username}
                onChange={(e) =>
                  setUsername(
                    e.target.value
                  )
                }
                minLength={3}
                required
              />
            )}

            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(e) =>
                setEmail(
                  e.target.value
                )
              }
              required
            />

            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(e) =>
                setPassword(
                  e.target.value
                )
              }
              minLength={8}
              required
            />

            <button
              className="primary-button"
              disabled={loading}
            >
              {loading
                ? "Please wait..."
                : mode ===
                  "login"
                ? "Login"
                : "Create Account"}
            </button>
          </form>

          {notice && (
            <div className="success-message">
              {notice}
            </div>
          )}

          {error && (
            <div className="error-message">
              {error}
            </div>
          )}

          <div className="switch-text">
            {mode ===
            "login" ? (
              <>
                Don't have an
                account?

                <button
                  onClick={() => {
                    setMode(
                      "register"
                    );

                    setError("");
                    setNotice("");
                  }}
                >
                  Register
                </button>
              </>
            ) : (
              <>
                Already have an
                account?

                <button
                  onClick={() => {
                    setMode("login");

                    setError("");
                    setNotice("");
                  }}
                >
                  Login
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">

      {/* SIDEBAR */}

      <aside className="sidebar">

        <div className="brand">
          <div className="brand-logo">
            VC
          </div>

          <div>
            <h2>VibeChat</h2>

            <span>
              Connect • Chat • Vibe
            </span>
          </div>
        </div>

        <div className="profile-box">

          <div
            className="avatar"
            style={{
              background:
                getAvatarColor(
                  user.id
                ),
            }}
          >
            {getInitials(
              user.username
            )}
          </div>

          <div className="profile-info">
            <strong>
              {user.username}
            </strong>

            <span>
              Online
            </span>
          </div>

          <div className="online-dot" />
        </div>

        <nav className="sidebar-nav">

          <button
            className={
              activePage ===
              "dashboard"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() => {
              setActivePage(
                "dashboard"
              );

              setSelectedChat(
                null
              );
            }}
          >
            🏠
            <span>
              Dashboard
            </span>
          </button>

          <button
            className={
              activePage ===
              "messages"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() =>
              setActivePage(
                "messages"
              )
            }
          >
            💬
            <span>
              Messages
            </span>

            {chats.length >
              0 && (
              <b>
                {chats.length}
              </b>
            )}
          </button>

          <button
            className={
              activePage ===
              "contacts"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() =>
              setActivePage(
                "contacts"
              )
            }
          >
            👥
            <span>
              Contacts
            </span>
          </button>

          <button
            className={
              activePage ===
              "favorites"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() =>
              setActivePage(
                "favorites"
              )
            }
          >
            ⭐
            <span>
              Favorites
            </span>
          </button>

          <button
            className={
              activePage ===
              "settings"
                ? "nav-item active"
                : "nav-item"
            }
            onClick={() =>
              setActivePage(
                "settings"
              )
            }
          >
            ⚙️
            <span>
              Settings
            </span>
          </button>

        </nav>

        <button
          className="logout-button"
          onClick={logout}
        >
          🚪 Logout
        </button>

      </aside>

      {/* MAIN */}

      <main className="main-area">

        <header className="topbar">

          <div>
            <h2>
              {activePage ===
              "dashboard"
                ? "Dashboard"
                : activePage ===
                  "messages"
                ? "Messages"
                : activePage ===
                  "contacts"
                ? "Contacts"
                : activePage ===
                  "favorites"
                ? "Favorites"
                : "Settings"}
            </h2>

            <p>
              Welcome back to
              VibeChat
            </p>
          </div>

          <div className="top-profile">

            <div
              className="mini-avatar"
              style={{
                background:
                  getAvatarColor(
                    user.id
                  ),
              }}
            >
              {getInitials(
                user.username
              )}
            </div>

            <div>
              <strong>
                {user.username}
              </strong>

              <small>
                {user.email}
              </small>
            </div>

          </div>
        </header>

        {error && (
          <div className="global-error">
            {error}
          </div>
        )}

        {notice && (
          <div className="global-notice">
            {notice}
          </div>
        )}

        {/* DASHBOARD */}

        {activePage ===
          "dashboard" && (
          <section className="page-content">

            <div className="welcome-row">

              <div>
                <h1>
                  Good afternoon,{" "}
                  <span>
                    {user.username} 👋
                  </span>
                </h1>

                <p>
                  Here's what's
                  happening with
                  your VibeChat
                  today.
                </p>
              </div>

              <button
                className="new-chat"
                onClick={() =>
                  setActivePage(
                    "messages"
                  )
                }
              >
                + New Chat
              </button>

            </div>

            <div className="stats-grid">

              <div className="stat-card">
                <div className="stat-icon">
                  💬
                </div>

                <div>
                  <span>
                    Total Chats
                  </span>

                  <h2>
                    {chats.length}
                  </h2>

                  <small>
                    Your conversations
                  </small>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon">
                  🟢
                </div>

                <div>
                  <span>
                    Online
                  </span>

                  <h2>
                    ●
                  </h2>

                  <small>
                    You are online
                  </small>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon">
                  👥
                </div>

                <div>
                  <span>
                    Contacts
                  </span>

                  <h2>
                    {chats.length}
                  </h2>

                  <small>
                    Your contacts
                  </small>
                </div>
              </div>

              <div className="stat-card">
                <div className="stat-icon">
                  💖
                </div>

                <div>
                  <span>
                    Favorites
                  </span>

                  <h2>
                    {favorites.length}
                  </h2>

                  <small>
                    Favorite contacts
                  </small>
                </div>
              </div>

            </div>

            <div className="dashboard-panels">

              <div className="panel">

                <div className="panel-heading">
                  <div>
                    <h3>
                      Recent Conversations
                    </h3>

                    <p>
                      Your latest chats
                    </p>
                  </div>

                  <button
                    onClick={() =>
                      setActivePage(
                        "messages"
                      )
                    }
                  >
                    View all →
                  </button>
                </div>

                <div className="recent-list">

                  {loadingChats ? (
                    <div className="empty-small">
                      Loading chats...
                    </div>
                  ) : chats.length ===
                    0 ? (
                    <div className="empty-small">
                      No conversations
                      yet.
                    </div>
                  ) : (
                    chats
                      .slice(0, 5)
                      .map(
                        (chat) => {
                          const other =
                            getOtherUser(
                              chat
                            );

                          return (
                            <div
                              className="recent-item"
                              key={
                                chat.id
                              }
                              onClick={() =>
                                openChat(
                                  chat
                                )
                              }
                            >
                              <div
                                className="avatar"
                                style={{
                                  background:
                                    getAvatarColor(
                                      other.id
                                    ),
                                }}
                              >
                                {getInitials(
                                  other.username
                                )}
                              </div>

                              <div>
                                <strong>
                                  {
                                    other.username
                                  }
                                </strong>

                                <p>
                                  {chat.lastMessage
                                    ? chat
                                        .lastMessage
                                        .content ||
                                      "📎 Media"
                                    : "No messages yet"}
                                </p>
                              </div>
                            </div>
                          );
                        }
                      )
                  )}

                </div>
              </div>

              <div className="panel">

                <div className="panel-heading">
                  <div>
                    <h3>
                      Quick Actions
                    </h3>

                    <p>
                      Start something new
                    </p>
                  </div>
                </div>

                <div className="quick-actions">

                  <button
                    onClick={() =>
                      setActivePage(
                        "messages"
                      )
                    }
                  >
                    💬

                    <div>
                      <strong>
                        New Message
                      </strong>

                      <small>
                        Search and chat
                      </small>
                    </div>
                  </button>

                  <button
                    onClick={() =>
                      setActivePage(
                        "contacts"
                      )
                    }
                  >
                    👥

                    <div>
                      <strong>
                        Find Friends
                      </strong>

                      <small>
                        View your contacts
                      </small>
                    </div>
                  </button>

                </div>
              </div>

            </div>
          </section>
        )}

        {/* MESSAGES */}

        {activePage ===
          "messages" && (
          <section className="chat-page">

            <div className="chat-list">

              <div className="chat-search">
                🔍

                <input
                  placeholder="Search users..."
                  value={
                    searchQuery
                  }
                  onChange={(e) =>
                    searchUsers(
                      e.target.value
                    )
                  }
                />
              </div>

              {searchResults.length >
                0 && (
                <div className="search-results">

                  <small>
                    SEARCH RESULTS
                  </small>

                  {searchResults.map(
                    (result) => (
                      <div
                        className="chat-list-item"
                        key={
                          result.id
                        }
                        onClick={() =>
                          startNewChat(
                            result
                          )
                        }
                      >
                        <div
                          className="avatar"
                          style={{
                            background:
                              getAvatarColor(
                                result.id
                              ),
                          }}
                        >
                          {getInitials(
                            result.username
                          )}
                        </div>

                        <div className="chat-preview">
                          <strong>
                            {
                              result.username
                            }
                          </strong>

                          <p>
                            {
                              result.email
                            }
                          </p>
                        </div>
                      </div>
                    )
                  )}

                </div>
              )}

              <div className="chat-list-title">
                CHATS
              </div>

              {loadingChats ? (
                <div className="empty-small">
                  Loading...
                </div>
              ) : chats.length ===
                0 ? (
                <div className="empty-chat-list">
                  <div>
                    💬
                  </div>

                  <strong>
                    No chats yet
                  </strong>

                  <p>
                    Search a user
                    above to start
                    chatting.
                  </p>
                </div>
              ) : (
                chats.map(
                  (chat) => {
                    const other =
                      getOtherUser(
                        chat
                      );

                    return (
                      <div
                        className={
                          selectedChat?.id ===
                          chat.id
                            ? "chat-list-item selected"
                            : "chat-list-item"
                        }
                        key={
                          chat.id
                        }
                        onClick={() =>
                          openChat(
                            chat
                          )
                        }
                      >
                        <div
                          className="avatar"
                          style={{
                            background:
                              getAvatarColor(
                                other.id
                              ),
                          }}
                        >
                          {getInitials(
                            other.username
                          )}
                        </div>

                        <div className="chat-preview">
                          <strong>
                            {
                              other.username
                            }
                          </strong>

                          <p>
                            {chat.lastMessage
                              ? chat
                                  .lastMessage
                                  .content ||
                                "📎 Media"
                              : "No messages yet"}
                          </p>
                        </div>

                        <span className="chat-time">
                          {chat.lastMessage
                            ? "now"
                            : ""}
                        </span>
                      </div>
                    );
                  }
                )
              )}

            </div>

            <div className="conversation">

              {!selectedChat ? (
                <div className="conversation-empty">

                  <div className="empty-chat-icon">
                    💬
                  </div>

                  <h2>
                    Select a conversation
                  </h2>

                  <p>
                    Search for a
                    user to start
                    chatting.
                  </p>

                </div>
              ) : (
                <>
                  {(() => {
                    const other =
                      getOtherUser(
                        selectedChat
                      );

                    return (
                      <header className="conversation-header">

                        <div
                          className="avatar large"
                          style={{
                            background:
                              getAvatarColor(
                                other.id
                              ),
                          }}
                        >
                          {getInitials(
                            other.username
                          )}
                        </div>

                        <div className="conversation-user">
                          <h3>
                            {
                              other.username
                            }
                          </h3>

                          <span>
                            🟢 Online
                          </span>
                        </div>

                        <div className="chat-actions">

                          <button
                            title="Voice Call"
                            onClick={() =>
                              startCall(
                                "voice"
                              )
                            }
                          >
                            📞
                          </button>

                          <button
                            title="Video Call"
                            onClick={() =>
                              startCall(
                                "video"
                              )
                            }
                          >
                            🎥
                          </button>

                          <button
                            title="Favorite"
                            onClick={() =>
                              toggleFavorite(
                                other.id
                              )
                            }
                          >
                            {isFavorite(
                              other.id
                            )
                              ? "❤️"
                              : "🤍"}
                          </button>

                          <button
                            title="More"
                            onClick={() =>
                              showNotice(
                                "More options coming soon"
                              )
                            }
                          >
                            ⋮
                          </button>

                        </div>

                      </header>
                    );
                  })()}

                  <section className="messages-area">

                    {loadingMessages ? (
                      <div className="messages-loading">
                        Loading messages...
                      </div>
                    ) : messages.length ===
                      0 ? (
                      <div className="messages-empty">

                        <div>
                          👋
                        </div>

                        <h3>
                          No messages yet
                        </h3>

                        <p>
                          Send the first
                          message!
                        </p>

                      </div>
                    ) : (
                      messages.map(
                        (msg) => {
                          const mine =
                            Number(
                              msg.senderId
                            ) ===
                            Number(
                              user.id
                            );

                          return (
                            <div
                              key={
                                msg.id
                              }
                              className={
                                mine
                                  ? "message-row mine"
                                  : "message-row"
                              }
                            >

                              <div
                                className={
                                  mine
                                    ? "message-bubble outgoing"
                                    : "message-bubble incoming"
                                }
                              >

                                {renderMedia(
                                  msg
                                )}

                                {msg.content && (
                                  <p>
                                    {
                                      msg.content
                                    }
                                  </p>
                                )}

                                <div className="message-meta">

                                  <span>
                                    {new Date(
                                      msg.createdAt
                                    ).toLocaleTimeString(
                                      "en-IN",
                                      {
                                        hour: "2-digit",
                                        minute:
                                          "2-digit",
                                      }
                                    )}
                                  </span>

                                  {mine && (
                                    <span>
                                      ✓✓
                                    </span>
                                  )}

                                </div>

                                {msg.mediaUrl && (
                                  <div className="media-file-name">
                                    {msg.fileName}
                                  </div>
                                )}

                              </div>

                            </div>
                          );
                        }
                      )
                    )}

                  </section>

                  <div className="message-composer">
                    <input
                      ref={fileInputRef}
                      type="file"
                      className="hidden-file-input"
                      accept="image/*,video/*,audio/*,.pdf,.txt,.doc,.docx,.xls,.xlsx,.ppt,.pptx"
                      onChange={handleFileSelected}
                    />

                    <div className="attachment-wrapper">
                      <button
                        type="button"
                        className="composer-icon"
                        onClick={openFilePicker}
                        disabled={uploadingMedia}
                        title="Attach file"
                      >
                        {uploadingMedia ? "⏳" : "📎"}
                      </button>

                      {attachmentMenu && (
                        <div className="attachment-menu">
                          <button
                            type="button"
                            onClick={() => chooseAttachment("media")}
                          >
                            <span>📷</span>
                            <div>
                              <strong>Photos &amp; Videos</strong>
                              <small>Images and videos</small>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => chooseAttachment("audio")}
                          >
                            <span>🎵</span>
                            <div>
                              <strong>Audio</strong>
                              <small>Music and audio files</small>
                            </div>
                          </button>

                          <button
                            type="button"
                            onClick={() => chooseAttachment("document")}
                          >
                            <span>📄</span>
                            <div>
                              <strong>Documents</strong>
                              <small>PDF, Word, Excel and more</small>
                            </div>
                          </button>
                        </div>
                      )}
                    </div>

                    <input
                      type="text"
                      placeholder={
                        uploadingMedia
                          ? "Uploading media..."
                          : "Type a message..."
                      }
                      value={newMessage}
                      onChange={(e) => setNewMessage(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          sendMessage();
                        }
                      }}
                      disabled={uploadingMedia}
                    />

                    <button
                      type="button"
                      className="composer-icon"
                      onClick={handleVoice}
                      title="Voice message"
                    >
                      🎤
                    </button>

                    <button
                      type="button"
                      className="send-button"
                      onClick={sendMessage}
                      disabled={sendingMessage || uploadingMedia}
                    >
                      {sendingMessage ? "..." : "➤"}
                    </button>
                  </div>

                  <div className="upload-info">
                    📎 Photos, videos, audio &amp; documents • Max 25 MB
                  </div>

                </>
              )}

            </div>

          </section>
        )}

        {/* CONTACTS */}

        {activePage ===
          "contacts" && (
          <section className="page-content">

            <div className="page-title">
              <h1>
                👥 Contacts
              </h1>

              <p>
                People you have
                chatted with.
              </p>
            </div>

            {chats.length ===
            0 ? (
              <div className="empty-section">
                <div>
                  👥
                </div>

                <h2>
                  No contacts yet
                </h2>

                <p>
                  Start a conversation
                  from Messages.
                </p>
              </div>
            ) : (
              <div className="contacts-grid">

                {chats.map(
                  (chat) => {
                    const other =
                      getOtherUser(
                        chat
                      );

                    return (
                      <div
                        className="contact-card"
                        key={
                          chat.id
                        }
                      >
                        <div
                          className="contact-avatar-big"
                          style={{
                            background:
                              getAvatarColor(
                                other.id
                              ),
                          }}
                        >
                          {getInitials(
                            other.username
                          )}
                        </div>

                        <h3>
                          {
                            other.username
                          }
                        </h3>

                        <p>
                          {other.email}
                        </p>

                        <div className="contact-buttons">

                          <button
                            onClick={() =>
                              openChat(
                                chat
                              )
                            }
                          >
                            💬 Message
                          </button>

                          <button
                            onClick={() =>
                              toggleFavorite(
                                other.id
                              )
                            }
                          >
                            {isFavorite(
                              other.id
                            )
                              ? "❤️"
                              : "🤍"}
                          </button>

                        </div>
                      </div>
                    );
                  }
                )}

              </div>
            )}

          </section>
        )}

        {/* FAVORITES */}

        {activePage ===
          "favorites" && (
          <section className="page-content">

            <div className="page-title">
              <h1>
                ⭐ Favorites
              </h1>

              <p>
                Your favorite
                VibeChat contacts.
              </p>
            </div>

            {favorites.length ===
            0 ? (
              <div className="empty-section">

                <div>
                  ⭐
                </div>

                <h2>
                  No favorites yet
                </h2>

                <p>
                  Open a chat and
                  tap ❤️ to add
                  someone to
                  favorites.
                </p>

              </div>
            ) : (
              <div className="contacts-grid">

                {chats
                  .filter(
                    (chat) =>
                      isFavorite(
                        getOtherUser(
                          chat
                        ).id
                      )
                  )
                  .map(
                    (chat) => {
                      const other =
                        getOtherUser(
                          chat
                        );

                      return (
                        <div
                          className="contact-card"
                          key={
                            chat.id
                          }
                        >
                          <div
                            className="contact-avatar-big"
                            style={{
                              background:
                                getAvatarColor(
                                  other.id
                                ),
                            }}
                          >
                            {getInitials(
                              other.username
                            )}
                          </div>

                          <h3>
                            {
                              other.username
                            }
                          </h3>

                          <p>
                            ❤️ Favorite
                          </p>

                          <button
                            onClick={() =>
                              openChat(
                                chat
                              )
                            }
                          >
                            Open Chat
                          </button>

                        </div>
                      );
                    }
                  )}

              </div>
            )}

          </section>
        )}

        {/* SETTINGS */}

        {activePage ===
          "settings" && (
          <section className="page-content">

            <div className="page-title">

              <h1>
                ⚙️ Settings
              </h1>

              <p>
                Manage your
                VibeChat account.
              </p>

            </div>

            <div className="settings-card">

              <div className="settings-profile">

                <div
                  className="contact-avatar-big"
                  style={{
                    background:
                      getAvatarColor(
                        user.id
                      ),
                  }}
                >
                  {getInitials(
                    user.username
                  )}
                </div>

                <div>
                  <h2>
                    {user.username}
                  </h2>

                  <p>
                    {user.email}
                  </p>
                </div>

              </div>

              <div className="setting-row">

                <div>
                  <strong>
                    🔔 Notifications
                  </strong>

                  <small>
                    Receive chat
                    notifications
                  </small>
                </div>

                <button
                  className={
                    notifications
                      ? "toggle active"
                      : "toggle"
                  }
                  onClick={() =>
                    setNotifications(
                      !notifications
                    )
                  }
                >
                  {notifications
                    ? "ON"
                    : "OFF"}
                </button>

              </div>

              <div className="setting-row">

                <div>
                  <strong>
                    🌙 Dark Mode
                  </strong>

                  <small>
                    Change VibeChat
                    appearance
                  </small>
                </div>

                <button
                  className={
                    darkMode
                      ? "toggle active"
                      : "toggle"
                  }
                  onClick={() =>
                    setDarkMode(
                      !darkMode
                    )
                  }
                >
                  {darkMode
                    ? "ON"
                    : "OFF"}
                </button>

              </div>

              <div className="setting-row">

                <div>
                  <strong>
                    🔒 Privacy
                  </strong>

                  <small>
                    Your chats are
                    private
                  </small>
                </div>

                <button
                  onClick={() =>
                    showNotice(
                      "Privacy settings coming soon"
                    )
                  }
                >
                  Manage
                </button>

              </div>

              <div className="setting-row">

                <div>
                  <strong>
                    🚪 Account
                  </strong>

                  <small>
                    Logout from
                    VibeChat
                  </small>
                </div>

                <button
                  className="danger-button"
                  onClick={
                    logout
                  }
                >
                  Logout
                </button>

              </div>

            </div>

          </section>
        )}

      </main>

      {/* REAL VOICE / VIDEO CALL MODAL */}
      {callType && (
        <div className="call-overlay" role="dialog" aria-modal="true" aria-label="VibeChat call">
          <div
            className="call-card"
            style={{
              width: callType === "video" ? "min(900px, 94vw)" : undefined,
              maxWidth: "94vw",
              position: "relative",
              overflow: "hidden",
            }}
          >
            {!(callType === "video" && remoteStream) && (
              <div
                className="call-avatar"
                style={{ background: getAvatarColor(callPeer?.id || (selectedChat ? getOtherUser(selectedChat).id : user?.id || 0)) }}
              >
                {getInitials(callPeer?.username || (selectedChat ? getOtherUser(selectedChat).username : "VibeChat user"))}
              </div>
            )}

            <h2>{callPeer?.username || (selectedChat ? getOtherUser(selectedChat).username : "VibeChat user")}</h2>
            <p>{callType === "voice" ? "Voice call" : "Video call"}</p>
            <div className="call-status" aria-live="polite">{callStatus || "Connecting…"}</div>

            {/* This single remote element handles both remote video and voice-call audio. */}
            <video
              ref={remoteVideoRef}
              autoPlay
              playsInline
              style={callType === "video" && remoteStream ? { width: "100%", maxHeight: "55vh", objectFit: "cover", borderRadius: 14, background: "#111827", marginBottom: 14 } : { position: "absolute", width: 1, height: 1, opacity: 0, pointerEvents: "none" }}
            />
            {callType === "video" && localStream && (
              <video
                ref={localVideoRef}
                autoPlay
                playsInline
                muted
                style={{ width: 150, maxWidth: "35%", position: "absolute", right: 16, top: 16, borderRadius: 12, border: "2px solid white", background: "#111827", transform: "scaleX(-1)" }}
              />
            )}

            {incomingCall ? (
              <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginTop: 18 }}>
                <button className="end-call" onClick={rejectIncomingCall} style={{ background: "#6b7280" }}>Decline</button>
                <button className="end-call" onClick={acceptIncomingCall} style={{ background: "#059669" }}>Answer</button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 10, justifyContent: "center", flexWrap: "wrap", marginTop: 18 }}>
                <button type="button" className="end-call" onClick={toggleCallMute} style={{ background: callMuted ? "#b91c1c" : "#4b5563" }}>
                  {callMuted ? "Unmute mic" : "Mute mic"}
                </button>
                {callType === "video" && (
                  <button type="button" className="end-call" onClick={toggleCallCamera} style={{ background: cameraOff ? "#b91c1c" : "#4b5563" }}>
                    {cameraOff ? "Turn camera on" : "Turn camera off"}
                  </button>
                )}
                <button className="end-call" onClick={closeCall}>📞 End Call</button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default App;