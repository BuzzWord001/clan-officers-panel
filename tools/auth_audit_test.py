"""Аудит авторизации — запускается НА машине Fly, бьёт localhost:8765.

Минтит токены всех ролей (SESSION_SECRET в env машины) и проверяет:
1) Матрицу прав по ролям (none/guest/officer/admin) на ключевых эндпоинтах.
2) Cookie-аутентификацию (а не только Bearer) для каждой роли.
3) Реальные login-флоу: верный/неверный пароль офицера, неверный админ.
4) Битый/пустой токен -> 401.
"""
import json
import sys
import urllib.error
import urllib.request

sys.path.insert(0, "/app/backend")
import auth_pwd  # noqa: E402
import session   # noqa: E402

BASE = "http://127.0.0.1:8765"

TOKENS = {
    "none": None,
    "guest": session.make_token(role="guest", name="Гость"),
    "officer": session.make_token(role="officer", name="AUDIT_OFFICER"),
    "admin": session.make_token(role="admin", name="Администратор"),
}


def call(method, path, token=None, body=None, as_cookie=False):
    headers = {"Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token and as_cookie:
        headers["Cookie"] = "officer_session=" + token
    elif token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(BASE + path, data=data, headers=headers, method=method)
    try:
        return urllib.request.urlopen(req).status
    except urllib.error.HTTPError as e:
        return e.code
    except Exception as e:  # noqa: BLE001
        return "ERR:" + str(e)[:40]


# (method, path, body, {role: expected_status})
# 422 = авторизация ПРОЙДЕНА, тело невалидно (значит роль допущена к записи).
MATRIX = [
    ("GET",  "/auth/me",          None, {"none": 401, "guest": 200, "officer": 200, "admin": 200}),
    ("GET",  "/valor/current",    None, {"none": 401, "guest": 200, "officer": 200, "admin": 200}),
    ("GET",  "/valor/departed",   None, {"none": 401, "guest": 200, "officer": 200, "admin": 200}),
    ("GET",  "/valor/timeline",   None, {"none": 401, "guest": 200, "officer": 200, "admin": 200}),
    ("GET",  "/valor/sessions",   None, {"none": 401, "guest": 403, "officer": 200, "admin": 200}),
    ("POST", "/valor/warning",    {},   {"none": 401, "guest": 403, "officer": 422, "admin": 422}),
    ("GET",  "/acceptances",      None, {"none": 401, "guest": 403, "officer": 200, "admin": 200}),
    ("POST", "/acceptances",      {},   {"none": 401, "guest": 403, "officer": 422, "admin": 422}),
    ("GET",  "/audit",            None, {"none": 401, "guest": 403, "officer": 200, "admin": 200}),
    ("GET",  "/chat/stats",       None, {"none": 401, "guest": 403, "officer": 200, "admin": 200}),
    ("GET",  "/chat/groups",      None, {"none": 401, "guest": 403, "officer": 200, "admin": 200}),
    ("GET",  "/admin/login-log",  None, {"none": 401, "guest": 403, "officer": 403, "admin": 200}),
    ("GET",  "/admin/snapshots",  None, {"none": 401, "guest": 403, "officer": 403, "admin": 200}),
    ("GET",  "/admin/storage",    None, {"none": 401, "guest": 403, "officer": 403, "admin": 200}),
    ("GET",  "/admin/blocklist",  None, {"none": 401, "guest": 403, "officer": 403, "admin": 200}),
]

ROLES = ("none", "guest", "officer", "admin")
fails = 0
print("=== МАТРИЦА ПРАВ (Bearer) ===")
for method, path, body, exp in MATRIX:
    cells, row_ok = [], True
    for role in ROLES:
        got = call(method, path, TOKENS[role], body)
        ok = got == exp[role]
        row_ok = row_ok and ok
        cells.append(f"{role}={got}" + ("" if ok else f"(want {exp[role]})"))
    if not row_ok:
        fails += 1
    print(("OK  " if row_ok else "XX  ") + f"{method:4} {path:20} | " + "  ".join(cells))

print("\n=== COOKIE-АУТЕНТИФИКАЦИЯ (без Bearer) ===")
for role in ("guest", "officer", "admin"):
    got = call("GET", "/auth/me", TOKENS[role], as_cookie=True)
    ok = got == 200
    fails += 0 if ok else 1
    print(("OK  " if ok else "XX  ") + f"me by cookie [{role}] -> {got}")

print("\n=== БИТЫЙ/ПУСТОЙ ТОКЕН ===")
for label, tok in (("garbage", "abc.def.ghi"), ("empty", "")):
    got = call("GET", "/auth/me", tok or None)
    ok = got == 401
    fails += 0 if ok else 1
    print(("OK  " if ok else "XX  ") + f"me with {label} token -> {got} (want 401)")

print("\n=== LOGIN-ФЛОУ ===")
# Неверный пароль офицера
got = call("POST", "/auth/login", body={"game_nick": "AuditBot", "password": "definitely-wrong-xyz"})
ok = got == 401
fails += 0 if ok else 1
print(("OK  " if ok else "XX  ") + f"officer login WRONG pw -> {got} (want 401)")

# Верный пароль офицера (берём plain из БД, наружу не печатаем)
plain = auth_pwd.officer_password_plain()
got = call("POST", "/auth/login", body={"game_nick": "AuditBot", "password": plain})
ok = got == 200
fails += 0 if ok else 1
print(("OK  " if ok else "XX  ") + f"officer login CORRECT pw -> {got} (want 200)")

# Неверный админ
got = call("POST", "/auth/admin/login", body={"username": "nope", "password": "nope-too"})
ok = got == 401
fails += 0 if ok else 1
print(("OK  " if ok else "XX  ") + f"admin login WRONG creds -> {got} (want 401)")

# Гостевой вход
got = call("POST", "/auth/guest", body={})
ok = got == 200
fails += 0 if ok else 1
print(("OK  " if ok else "XX  ") + f"guest login -> {got} (want 200)")

# Logout
got = call("POST", "/auth/logout")
ok = got == 200
fails += 0 if ok else 1
print(("OK  " if ok else "XX  ") + f"logout -> {got} (want 200)")

print(f"\n=== ИТОГО: {'ВСЁ ОК' if fails == 0 else str(fails) + ' ПРОВАЛОВ'} ===")
