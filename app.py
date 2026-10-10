import json
import os
import re
import threading
from math import isfinite

import libsql
from flask import Flask, jsonify, render_template, request, session
from flask_socketio import SocketIO, emit
from werkzeug.security import check_password_hash, generate_password_hash


app = Flask(__name__)

app.config.update(
    SECRET_KEY=os.environ.get("SECRET_KEY", "local-dev-key-change-this"),
    SESSION_COOKIE_HTTPONLY=True,
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_SECURE=bool(os.environ.get("RENDER")),
)

socketio = SocketIO(app, cors_allowed_origins=None, async_mode="threading")

_schema_lock = threading.Lock()
_schema_ready = False

# Temporarily connected players. Persistent progress is stored in Turso.
online_players = {}

DEFAULT_SCOOTERS = ["Starter"]


def get_db():
    """Open a Turso connection and create the tables on first use."""
    global _schema_ready

    url = os.environ.get("TURSO_DATABASE_URL")
    token = os.environ.get("TURSO_AUTH_TOKEN")

    if not url or not token:
        raise RuntimeError(
            "TURSO_DATABASE_URL or TURSO_AUTH_TOKEN is missing."
        )

    conn = libsql.connect(database=url, auth_token=token)

    if not _schema_ready:
        with _schema_lock:
            if not _schema_ready:
                try:
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS users (
                            id INTEGER PRIMARY KEY AUTOINCREMENT,
                            username TEXT NOT NULL,
                            username_key TEXT NOT NULL UNIQUE,
                            password_hash TEXT NOT NULL,
                            created_at TEXT DEFAULT CURRENT_TIMESTAMP
                        )
                    """)
                    conn.execute("""
                        CREATE TABLE IF NOT EXISTS player_state (
                            user_id INTEGER PRIMARY KEY,
                            coins INTEGER NOT NULL DEFAULT 0,
                            owned_scooters_json TEXT NOT NULL DEFAULT '["Starter"]',
                            inventory_json TEXT NOT NULL DEFAULT '[]',
                            upgrades_json TEXT NOT NULL DEFAULT '{}',
                            equipped_scooter TEXT NOT NULL DEFAULT 'Starter',
                            level INTEGER NOT NULL DEFAULT 1,
                            xp INTEGER NOT NULL DEFAULT 0,
                            x REAL NOT NULL DEFAULT 0,
                            z REAL NOT NULL DEFAULT 0,
                            rotation REAL NOT NULL DEFAULT 0,
                            FOREIGN KEY (user_id) REFERENCES users(id)
                        )
                    """)
                    conn.commit()
                    _schema_ready = True
                except Exception:
                    conn.close()
                    raise

    return conn


def get_saved_player(conn, user_id):
    row = conn.execute("""
        SELECT
            u.id, u.username,
            p.coins, p.owned_scooters_json,
            p.inventory_json, p.upgrades_json,
            p.equipped_scooter, p.level, p.xp,
            p.x, p.z, p.rotation
        FROM users u
        JOIN player_state p ON p.user_id = u.id
        WHERE u.id = ?
    """, (user_id,)).fetchone()

    if row is None:
        return None

    return {
        "id": row[0],
        "username": row[1],
        "coins": row[2],
        "owned_scooters": json.loads(row[3]),
        "inventory": json.loads(row[4]),
        "upgrades": json.loads(row[5]),
        "equipped_scooter": row[6],
        "level": row[7],
        "xp": row[8],
        "x": row[9],
        "z": row[10],
        "rotation": row[11],
    }


def logged_in_user_id():
    user_id = session.get("user_id")
    return user_id if isinstance(user_id, int) else None


def valid_position(data):
    """Only accept finite, reasonably bounded movement values."""
    try:
        x = float(data.get("x", 0))
        z = float(data.get("z", 0))
        rotation = float(data.get("rotation", data.get("rot", 0)))
    except (TypeError, ValueError):
        return None

    if not all(isfinite(v) for v in (x, z, rotation)):
        return None

    if abs(x) > 100000 or abs(z) > 100000 or abs(rotation) > 100000:
        return None

    return x, z, rotation


def save_position(user_id, position):
    conn = get_db()
    try:
        conn.execute("""
            UPDATE player_state
            SET x = ?, z = ?, rotation = ?
            WHERE user_id = ?
        """, (*position, user_id))
        conn.commit()
    finally:
        conn.close()


@app.route("/")
def index():
    return render_template("index.html")


@app.get("/api/me")
def api_me():
    user_id = logged_in_user_id()
    if user_id is None:
        return jsonify(error="Bitte melde dich an."), 401

    conn = get_db()
    try:
        player = get_saved_player(conn, user_id)
        if player is None:
            session.clear()
            return jsonify(error="Account nicht gefunden."), 401
        return jsonify(player=player)
    finally:
        conn.close()


@app.post("/api/register")
def api_register():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = data.get("password", "")

    if not re.fullmatch(r"[A-Za-z0-9_]{3,20}", username):
        return jsonify(
            error="Der Benutzername muss 3–20 Zeichen haben "
                  "und darf nur Buchstaben, Zahlen und _ enthalten."
        ), 400

    if not isinstance(password, str) or not 8 <= len(password) <= 128:
        return jsonify(
            error="Das Passwort muss zwischen 8 und 128 Zeichen lang sein."
        ), 400

    username_key = username.casefold()
    password_hash = generate_password_hash(password)

    conn = get_db()
    try:
        existing = conn.execute(
            "SELECT id FROM users WHERE username_key = ?",
            (username_key,),
        ).fetchone()

        if existing:
            return jsonify(error="Dieser Benutzername ist bereits vergeben."), 409

        try:
            conn.execute("""
                INSERT INTO users (username, username_key, password_hash)
                VALUES (?, ?, ?)
            """, (username, username_key, password_hash))

            user = conn.execute(
                "SELECT id, username FROM users WHERE username_key = ?",
                (username_key,),
            ).fetchone()

            user_id = user[0]
            conn.execute("""
                INSERT INTO player_state (user_id, owned_scooters_json)
                VALUES (?, ?)
            """, (user_id, json.dumps(DEFAULT_SCOOTERS)))
            conn.commit()

        except Exception as exc:
            conn.rollback()
            # Handles two people registering the same name at once.
            if "unique" in str(exc).lower():
                return jsonify(
                    error="Dieser Benutzername ist bereits vergeben."
                ), 409
            app.logger.exception("Registration failed")
            return jsonify(error="Registrierung gerade nicht möglich."), 500

        session.clear()
        session["user_id"] = user_id

        player = get_saved_player(conn, user_id)
        return jsonify(player=player), 201
    finally:
        conn.close()


@app.post("/api/login")
def api_login():
    data = request.get_json(silent=True) or {}
    username = str(data.get("username", "")).strip()
    password = data.get("password", "")

    if not username or not isinstance(password, str):
        return jsonify(error="Benutzername oder Passwort ist falsch."), 401

    conn = get_db()
    try:
        row = conn.execute("""
            SELECT id, password_hash
            FROM users
            WHERE username_key = ?
        """, (username.casefold(),)).fetchone()

        if row is None or not check_password_hash(row[1], password):
            return jsonify(error="Benutzername oder Passwort ist falsch."), 401

        session.clear()
        session["user_id"] = row[0]

        player = get_saved_player(conn, row[0])
        return jsonify(player=player)
    finally:
        conn.close()


@app.post("/api/logout")
def api_logout():
    session.clear()
    return jsonify(ok=True)


@app.post("/api/save-position")
def api_save_position():
    user_id = logged_in_user_id()
    if user_id is None:
        return jsonify(error="Bitte melde dich erneut an."), 401

    position = valid_position(request.get_json(silent=True) or {})
    if position is None:
        return jsonify(error="Ungültige Position."), 400

    save_position(user_id, position)
    return jsonify(ok=True)


@socketio.on("connect")
def socket_connect(auth=None):
    # The browser may connect before the user logs in.
    # Authentication is checked when it requests to join the game.
    return


@socketio.on("join_game")
def socket_join_game(data=None):
    user_id = logged_in_user_id()
    if user_id is None:
        emit("auth_required", {"message": "Bitte zuerst anmelden."})
        return

    conn = get_db()
    try:
        player = get_saved_player(conn, user_id)
    finally:
        conn.close()

    if player is None:
        emit("auth_required", {"message": "Account nicht gefunden."})
        return

    sid = socket_request.sid
    online_players[sid] = {
        "id": sid,
        "user_id": user_id,
        "username": player["username"],
        "x": player["x"],
        "z": player["z"],
        "rot": player["rotation"],
        "speed": 0,
    }

    emit("welcome", {
        "id": sid,
        "players": list(online_players.values()),
    })
    socketio.emit("players_update", list(online_players.values()))


@socketio.on("move")
def socket_move(data):
    sid = socket_request.sid
    user_id = logged_in_user_id()

    if user_id is None or sid not in online_players:
        return

    position = valid_position(data or {})
    if position is None:
        return

    x, z, rotation = position
    online_players[sid].update({
        "x": x,
        "z": z,
        "rot": rotation,
    })

    try:
        speed = float((data or {}).get("speed", 0))
        if isfinite(speed):
            online_players[sid]["speed"] = max(0, min(speed, 300))
    except (TypeError, ValueError):
        pass

    socketio.emit("players_update", list(online_players.values()))


@socketio.on("save_state")
def socket_save_state(data=None):
    user_id = logged_in_user_id()
    sid = socket_request.sid

    if user_id is None or sid not in online_players:
        return

    position = valid_position(data or {})
    if position is None:
        return

    try:
        save_position(user_id, position)
    except Exception:
        app.logger.exception("Could not save player position")


@socketio.on("disconnect")
def socket_disconnect(reason=None):
    sid = socket_request.sid
    if sid in online_players:
        online_players.pop(sid, None)
        socketio.emit("players_update", list(online_players.values()))


if __name__ == "__main__":
    socketio.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))
