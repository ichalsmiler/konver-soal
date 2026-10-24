#!/usr/bin/env bash
#
# Installer Konver Soal untuk Ubuntu Server (20.04 / 22.04 / 24.04).
# Aplikasi ini statis (HTML/JS), jadi cukup dilayani nginx.
#
# Pemakaian (dari dalam folder hasil git clone):
#   sudo bash deploy/install.sh                         # http://IP-SERVER/
#   sudo bash deploy/install.sh --port 8080             # http://IP-SERVER:8080/
#   sudo bash deploy/install.sh --domain soal.sekolah.sch.id
#   sudo bash deploy/install.sh --domain soal.sekolah.sch.id --email admin@sekolah.sch.id   # + HTTPS
#   sudo bash deploy/install.sh --update                # git pull lalu pasang ulang
#   sudo bash deploy/install.sh --smtp                  # atur akun Gmail pengirim (fitur Kirim)
#   sudo bash deploy/install.sh --admin                 # atur kata sandi admin (kunci semester & tahun ajaran)
#   sudo bash deploy/install.sh --uninstall
#
set -euo pipefail

APP="konver-soal"
REPO_URL="${REPO_URL:-https://github.com/ichalsmiler/konver-soal.git}"
WEB_DIR="/var/www/${APP}"
SITE_FILE="/etc/nginx/sites-available/${APP}"
SITE_LINK="/etc/nginx/sites-enabled/${APP}"
CLONE_DIR="/opt/${APP}"

DOMAIN=""
PORT="80"
EMAIL=""
MODE="install"
SET_SMTP=0
SET_ADMIN=0

# Layanan "Kirim soal" (email)
KIRIM_DIR="/usr/local/lib/${APP}"
KIRIM_ENV_DIR="/etc/${APP}"
KIRIM_ENV="${KIRIM_ENV_DIR}/kirim.env"
KIRIM_SERVICE="${APP}-kirim"
KIRIM_PORT="3091"
MAIL_TO="${MAIL_TO:-terimasoal@sman2makassar.sch.id}"
API_SNIPPET="/etc/nginx/snippets/${APP}-api.conf"

c_ok=$'\e[32m'; c_warn=$'\e[33m'; c_err=$'\e[31m'; c_off=$'\e[0m'
info() { echo "${c_ok}==>${c_off} $*"; }
warn() { echo "${c_warn}[!]${c_off} $*"; }
die()  { echo "${c_err}[x]${c_off} $*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Pemakaian: sudo bash deploy/install.sh [opsi]
  --port N        port HTTP (bawaan 80)
  --domain NAMA   nama domain, mis. soal.sekolah.sch.id
  --email ALAMAT  aktifkan HTTPS Let's Encrypt (butuh --domain)
  --update        git pull lalu pasang ulang (konfigurasi lama dipertahankan)
  --smtp          atur akun Gmail pengirim untuk tombol Kirim (ditanya interaktif)
  --cek-smtp      uji login akun pengirim ke Gmail (tanpa mengirim email)
  --admin         atur kata sandi admin untuk mengunci semester & tahun ajaran (ditanya interaktif)
  --uninstall     hapus situs dari nginx
EOF
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain)    DOMAIN="${2:-}"; shift 2 ;;
    --port)      PORT="${2:-}"; shift 2 ;;
    --email)     EMAIL="${2:-}"; shift 2 ;;
    --update)    MODE="update"; shift ;;
    --smtp)      SET_SMTP=1; shift ;;
    --admin)     SET_ADMIN=1; shift ;;
    --cek-smtp)  MODE="cek"; shift ;;
    --uninstall) MODE="uninstall"; shift ;;
    -h|--help)   usage ;;
    *) die "Opsi tidak dikenal: $1 (lihat --help)" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "Jalankan dengan sudo: sudo bash $0 $*"
[[ "$PORT" =~ ^[0-9]+$ ]] && (( PORT >= 1 && PORT <= 65535 )) || die "Port tidak valid: $PORT"
if [[ -n "$EMAIL" && -z "$DOMAIN" ]]; then die "HTTPS (--email) butuh --domain."; fi
if [[ -r /etc/os-release ]]; then
  . /etc/os-release
  [[ "${ID:-}" == "ubuntu" || "${ID_LIKE:-}" == *debian* ]] || warn "Skrip ini dibuat untuk Ubuntu, terdeteksi: ${PRETTY_NAME:-tidak diketahui}"
fi

# Jalankan "node kirim.js --cek" dengan variabel dari file pengaturan (dibaca per baris,
# bukan di-source, karena nilai boleh mengandung spasi).
cek_smtp() {
  (
    while IFS='=' read -r k v; do export "$k=$v"; done < <(grep -E '^[A-Z_]+=' "$KIRIM_ENV")
    node "$KIRIM_DIR/kirim.js" --cek
  )
}

# ---------- Cek login SMTP ----------
if [[ "$MODE" == "cek" ]]; then
  [[ -f "$KIRIM_ENV" && -f "$KIRIM_DIR/kirim.js" ]] || die "Layanan kirim belum terpasang. Jalankan dulu: sudo bash $0 --update --smtp"
  cek_smtp
  exit $?
fi

# ---------- Uninstall ----------
if [[ "$MODE" == "uninstall" ]]; then
  info "Menghapus konfigurasi nginx dan file web ${APP}"
  rm -f "$SITE_LINK" "$SITE_FILE" "$API_SNIPPET"
  rm -rf "$WEB_DIR"
  if systemctl list-unit-files 2>/dev/null | grep -q "^${KIRIM_SERVICE}"; then
    systemctl disable --now "$KIRIM_SERVICE" >/dev/null 2>&1 || true
    rm -f "/etc/systemd/system/${KIRIM_SERVICE}.service"
    systemctl daemon-reload
  fi
  rm -rf "$KIRIM_DIR"
  warn "Pengaturan email di ${KIRIM_ENV} tidak dihapus (hapus manual bila perlu)."
  if command -v nginx >/dev/null && nginx -t >/dev/null 2>&1; then systemctl reload nginx; fi
  info "Selesai. Folder sumber (git clone) tidak dihapus."
  exit 0
fi

# ---------- Lokasi sumber ----------
SRC_DIR="/nonexistent"
if [[ -n "${BASH_SOURCE[0]:-}" && -f "${BASH_SOURCE[0]}" ]]; then
  SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fi
RUN_USER="${SUDO_USER:-root}"

git_auth() {
  # Token GitHub (repo private) dikirim lewat header, tidak disimpan di .git/config.
  if [[ -n "${GITHUB_TOKEN:-}" ]]; then
    local basic
    basic="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
    git -c http.extraHeader="Authorization: Basic ${basic}" "$@"
  else
    git "$@"
  fi
}

info "Memasang paket: nginx git rsync nodejs"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq </dev/null
apt-get install -y -qq nginx git rsync </dev/null >/dev/null
if ! command -v node >/dev/null; then apt-get install -y -qq nodejs </dev/null >/dev/null; fi
if [[ -n "$EMAIL" ]]; then
  info "Memasang certbot untuk HTTPS"
  apt-get install -y -qq certbot python3-certbot-nginx </dev/null >/dev/null
fi

if [[ ! -f "$SRC_DIR/index.html" ]]; then
  # Skrip dijalankan sendirian (mis. lewat curl): ambil sumber dari GitHub.
  SRC_DIR="$CLONE_DIR"
  if [[ ! -d "$SRC_DIR/.git" ]]; then
    info "Mengunduh sumber dari $REPO_URL ke $SRC_DIR"
    git_auth clone --depth 1 "$REPO_URL" "$SRC_DIR" </dev/null ||
      die "Gagal clone. Repo private? Jalankan dengan: sudo GITHUB_TOKEN=xxxx bash $0"
  fi
  RUN_USER="root"
fi

if [[ "$MODE" == "update" ]]; then
  [[ -d "$SRC_DIR/.git" ]] || die "$SRC_DIR bukan folder git, tidak bisa update."
  info "Mengambil versi terbaru (git pull) di $SRC_DIR"
  RUN_USER="$(stat -c %U "$SRC_DIR")"   # jalankan git sebagai pemilik folder
  if [[ "$RUN_USER" != "root" ]]; then
    sudo -u "$RUN_USER" git -C "$SRC_DIR" pull --ff-only
  else
    git_auth -c safe.directory="$SRC_DIR" -C "$SRC_DIR" pull --ff-only
  fi
  # Pakai konfigurasi yang sudah ada bila opsi tidak diberikan ulang.
  if [[ -f "$SITE_FILE" ]]; then
    [[ -n "$DOMAIN" ]] || DOMAIN="$(awk '/server_name/ {gsub(";",""); print $2; exit}' "$SITE_FILE")"
    [[ "$PORT" != "80" ]] || PORT="$(awk '/listen/ && !/ssl/ && !/\[::\]/ {gsub(";",""); print $2; exit}' "$SITE_FILE")"
    if [[ "$DOMAIN" == "_" ]]; then DOMAIN=""; fi
    if grep -q "managed by Certbot" "$SITE_FILE"; then KEEP_CERT=1; fi
  fi
fi
[[ -f "$SRC_DIR/index.html" ]] || die "index.html tidak ditemukan di $SRC_DIR"

# ---------- Salin file web ----------
info "Menyalin aplikasi ke $WEB_DIR"
mkdir -p "$WEB_DIR"
rsync -a --delete \
  --exclude '.git' --exclude '.github' --exclude '.githooks' --exclude '.claude' --exclude 'deploy' --exclude 'server' \
  --exclude '*.md' --exclude '.gitignore' \
  "$SRC_DIR/" "$WEB_DIR/"
chown -R www-data:www-data "$WEB_DIR"
find "$WEB_DIR" -type d -exec chmod 755 {} +
find "$WEB_DIR" -type f -exec chmod 644 {} +

# ---------- Layanan "Kirim soal" ke email ----------
info "Memasang layanan kirim email (${KIRIM_SERVICE})"
mkdir -p "$KIRIM_DIR" "$KIRIM_ENV_DIR"
install -m 644 "$SRC_DIR/server/kirim.js" "$KIRIM_DIR/kirim.js"
if [[ ! -f "$KIRIM_ENV" ]]; then
  cat > "$KIRIM_ENV" <<ENV
# Akun Gmail pengirim untuk tombol "Kirim" (isi lewat: sudo bash deploy/install.sh --smtp)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=465
SMTP_SECURE=true
SMTP_USER=
SMTP_PASS=
MAIL_TO=${MAIL_TO}
MAIL_FROM_NAME=Konver Soal
PORT=${KIRIM_PORT}
HOST=127.0.0.1
RATE_PER_HOUR=20
ENV
fi
chmod 600 "$KIRIM_ENV"

set_env() { # set_env KUNCI NILAI (tanpa menampilkan nilai)
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  grep -v "^${key}=" "$KIRIM_ENV" > "$tmp" || true
  printf '%s=%s\n' "$key" "$val" >> "$tmp"
  install -m 600 "$tmp" "$KIRIM_ENV"
  rm -f "$tmp"
}
# Alamat penerima selalu mengikuti versi terbaru skrip (juga saat --update).
set_env MAIL_TO "$MAIL_TO"
if [[ "$SET_SMTP" == "1" || -n "${SMTP_USER:-}" ]]; then
  if [[ -z "${SMTP_USER:-}" ]]; then
    [[ -r /dev/tty ]] || die "--smtp butuh terminal interaktif (atau berikan SMTP_USER dan SMTP_PASS sebagai variabel)."
    read -r -p "Alamat email pengirim (mis. kirimsoal@sman2makassar.sch.id): " SMTP_USER </dev/tty
    read -r -s -p "App Password Gmail (16 huruf, tidak tampil): " SMTP_PASS </dev/tty; echo
  fi
  # Buang spasi/karakter kontrol yang ikut tertempel.
  SMTP_USER="$(printf '%s' "$SMTP_USER" | tr -d '[:space:][:cntrl:]')"
  SMTP_PASS="$(printf '%s' "${SMTP_PASS:-}" | tr -d '[:space:][:cntrl:]')"
  [[ -n "$SMTP_USER" && -n "$SMTP_PASS" ]] || die "Alamat Gmail dan App Password wajib diisi."
  if [[ ! "$SMTP_PASS" =~ ^[a-zA-Z]{16}$ ]]; then
    warn "Sandi yang dimasukkan ${#SMTP_PASS} karakter. App Password Google biasanya tepat 16 huruf - pastikan bukan sandi akun biasa."
  fi
  set_env SMTP_USER "$SMTP_USER"
  set_env SMTP_PASS "$SMTP_PASS"
  info "Akun pengirim disimpan di ${KIRIM_ENV} (hanya bisa dibaca root)"
fi
if [[ "$SET_ADMIN" == "1" || -n "${ADMIN_PASS:-}" ]]; then
  if [[ -z "${ADMIN_PASS:-}" ]]; then
    [[ -r /dev/tty ]] || die "--admin butuh terminal interaktif (atau berikan ADMIN_PASS sebagai variabel)."
    read -r -s -p "Kata sandi admin baru (min. 8 karakter, tidak tampil): " ADMIN_PASS </dev/tty; echo
    read -r -s -p "Ulangi kata sandi admin: " ADMIN_PASS2 </dev/tty; echo
    [[ "$ADMIN_PASS" == "$ADMIN_PASS2" ]] || die "Kata sandi tidak sama."
  fi
  ADMIN_PASS="$(printf '%s' "$ADMIN_PASS" | tr -d '[:cntrl:]')"
  (( ${#ADMIN_PASS} >= 8 )) || die "Kata sandi admin minimal 8 karakter."
  [[ "$ADMIN_PASS" != *[\"\'\\[:space:]]* ]] || die "Kata sandi admin tidak boleh berisi spasi, tanda kutip, atau garis miring terbalik (\\)."
  set_env ADMIN_PASS "$ADMIN_PASS"
  info "Kata sandi admin disimpan di ${KIRIM_ENV} (hanya bisa dibaca root)"
fi

cat > "/etc/systemd/system/${KIRIM_SERVICE}.service" <<UNIT
[Unit]
Description=Konver Soal - layanan kirim soal ke email
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=${KIRIM_ENV}
ExecStart=$(command -v node) ${KIRIM_DIR}/kirim.js
Restart=on-failure
DynamicUser=yes
# Pengaturan admin (semester & tahun ajaran yang dikunci): /var/lib/${APP}/pengaturan.json
StateDirectory=${APP}
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable "$KIRIM_SERVICE" >/dev/null 2>&1
systemctl restart "$KIRIM_SERVICE"

mkdir -p "$(dirname "$API_SNIPPET")"
cat > "$API_SNIPPET" <<NGINX
# Dibuat oleh deploy/install.sh: tombol "Kirim" -> layanan email lokal
location = /api/kirim {
    proxy_pass http://127.0.0.1:${KIRIM_PORT}/api/kirim;
    proxy_set_header X-Real-IP \$remote_addr;
    client_max_body_size 40m;
    proxy_read_timeout 120s;
}
location = /api/kirim/status {
    proxy_pass http://127.0.0.1:${KIRIM_PORT}/api/kirim/status;
}
location = /api/pengaturan {
    proxy_pass http://127.0.0.1:${KIRIM_PORT}/api/pengaturan;
    proxy_set_header X-Real-IP \$remote_addr;
    add_header Cache-Control "no-store" always;
}
NGINX

# ---------- Konfigurasi nginx ----------
if [[ "${KEEP_CERT:-0}" == "1" ]]; then
  info "Konfigurasi HTTPS yang ada dipertahankan"
  # Sisipkan rute /api/kirim ke konfigurasi lama bila belum ada.
  if ! grep -q "$API_SNIPPET" "$SITE_FILE"; then
    sed -i "s|^\(\s*\)root ${WEB_DIR};|&\n\1include ${API_SNIPPET};|" "$SITE_FILE"
  fi
else
  SERVER_NAME="${DOMAIN:-_}"
  info "Menulis konfigurasi nginx (server_name ${SERVER_NAME}, port ${PORT})"
  cat > "$SITE_FILE" <<NGINX
# Dibuat oleh deploy/install.sh (Konver Soal)
server {
    listen ${PORT};
    listen [::]:${PORT};
    server_name ${SERVER_NAME};

    root ${WEB_DIR};
    include ${API_SNIPPET};
    index index.html;

    add_header X-Content-Type-Options "nosniff" always;
    add_header X-Frame-Options "SAMEORIGIN" always;
    add_header Referrer-Policy "same-origin" always;

    gzip on;
    gzip_types text/css application/javascript text/javascript;

    location / {
        try_files \$uri \$uri/ =404;
        add_header Cache-Control "no-cache";
    }

    location ~* \.(?:js|css)\$ {
        expires 1h;
    }

    location ~ /\. {
        deny all;
    }
}
NGINX
  ln -sf "$SITE_FILE" "$SITE_LINK"

  # Situs bawaan nginx bentrok dengan server_name "_" di port 80.
  if [[ -z "$DOMAIN" && "$PORT" == "80" && -e /etc/nginx/sites-enabled/default ]]; then
    warn "Menonaktifkan situs bawaan nginx (/etc/nginx/sites-enabled/default)"
    rm -f /etc/nginx/sites-enabled/default
  fi
fi

nginx -t >/dev/null 2>&1 || { nginx -t; die "Konfigurasi nginx tidak valid."; }
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl reload nginx

# ---------- Firewall ----------
if command -v ufw >/dev/null && ufw status 2>/dev/null | grep -q "Status: active"; then
  info "Membuka port ${PORT} di ufw"
  ufw allow "${PORT}/tcp" >/dev/null
  if [[ -n "$EMAIL" ]]; then ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; fi
fi

# ---------- HTTPS ----------
if [[ -n "$EMAIL" && "${KEEP_CERT:-0}" != "1" ]]; then
  info "Meminta sertifikat HTTPS Let's Encrypt untuk $DOMAIN"
  certbot --nginx -d "$DOMAIN" -m "$EMAIL" --agree-tos --non-interactive --redirect </dev/null ||
    warn "Certbot gagal. Pastikan domain $DOMAIN sudah mengarah ke IP server ini dan port 80 terbuka."
fi

# ---------- Ringkasan ----------
IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
PORT_SUFFIX=""
if [[ "$PORT" != "80" ]]; then PORT_SUFFIX=":$PORT"; fi
if [[ -n "$EMAIL" || "${KEEP_CERT:-0}" == "1" ]]; then URL="https://${DOMAIN}/"
elif [[ -n "$DOMAIN" ]]; then URL="http://${DOMAIN}${PORT_SUFFIX}/"
else URL="http://${IP:-IP-SERVER}${PORT_SUFFIX}/"
fi
echo
info "Konver Soal terpasang."
echo "    Buka      : ${URL}"
echo "    File web  : ${WEB_DIR}"
echo "    Sumber    : ${SRC_DIR}"
echo "    Update    : sudo bash ${SRC_DIR}/deploy/install.sh --update"
if grep -q '^SMTP_USER=.\+' "$KIRIM_ENV" && grep -q '^SMTP_PASS=.\+' "$KIRIM_ENV"; then
  echo "    Kirim     : aktif -> ${MAIL_TO}  (uji login: sudo bash ${SRC_DIR}/deploy/install.sh --cek-smtp)"
  if [[ "$SET_SMTP" == "1" ]]; then echo; info "Menguji login akun pengirim..."; cek_smtp || true; fi
else
  warn "Tombol Kirim belum aktif. Atur akun Gmail pengirim: sudo bash ${SRC_DIR}/deploy/install.sh --update --smtp"
fi
if grep -q '^ADMIN_PASS=.\+' "$KIRIM_ENV"; then
  echo "    Admin     : aktif (kunci semester & tahun ajaran lewat tautan \"Pengaturan admin\" di aplikasi)"
else
  warn "Kata sandi admin belum diatur. Atur dengan: sudo bash ${SRC_DIR}/deploy/install.sh --update --admin"
fi
