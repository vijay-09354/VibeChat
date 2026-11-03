import { useState } from "react";
import "./App.css";

const API_URL = "http://localhost:5000";

function App() {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setMessage("");
    setLoading(true);

    try {
      const endpoint =
        mode === "login"
          ? "/api/auth/login"
          : "/api/auth/register";

      const body =
        mode === "login"
          ? { email, password }
          : { username, email, password };

      const response = await fetch(API_URL + endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.message || "Something went wrong");
      }

      if (mode === "login") {
        localStorage.setItem("token", data.token);
        localStorage.setItem("user", JSON.stringify(data.user));

        setUser(data.user);
        setMessage("Login successful! 🎉");
      } else {
        setMessage("Account created successfully! 🎉");
        setMode("login");
        setUsername("");
      }

      setPassword("");
    } catch (error) {
      setMessage(error.message);
    } finally {
      setLoading(false);
    }
  }

  function logout() {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setUser(null);
    setEmail("");
    setPassword("");
    setMessage("");
  }

  if (user) {
    return (
      <div className="app">
        <div className="card">
          <div className="logo">VC</div>

          <h1>VibeChat</h1>

          <p className="subtitle">Welcome back, {user.username}! 👋</p>

          <div className="profile">
            <p>
              <strong>Username:</strong> {user.username}
            </p>

            <p>
              <strong>Email:</strong> {user.email}
            </p>
          </div>

          <button className="button" onClick={logout}>
            Logout
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="card">
        <div className="logo">VC</div>

        <h1>VibeChat</h1>

        <p className="subtitle">
          {mode === "login"
            ? "Login to continue chatting"
            : "Create your VibeChat account"}
        </p>

        <form onSubmit={handleSubmit}>
          {mode === "register" && (
            <input
              type="text"
              placeholder="Username"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
            />
          )}

          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
          />

          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          <button className="button" type="submit" disabled={loading}>
            {loading
              ? "Please wait..."
              : mode === "login"
              ? "Login"
              : "Create Account"}
          </button>
        </form>

        {message && <div className="message">{message}</div>}

        <div className="switch">
          {mode === "login" ? (
            <>
              Don't have an account?{" "}
              <button onClick={() => setMode("register")}>
                Register
              </button>
            </>
          ) : (
            <>
              Already have an account?{" "}
              <button onClick={() => setMode("login")}>
                Login
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;