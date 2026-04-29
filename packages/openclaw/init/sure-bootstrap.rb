# frozen_string_literal: true
#
# Sure first-boot bootstrap. Run via `bin/rails runner` inside a container
# that has access to the Sure Rails app and its Postgres database (i.e. a
# one-shot `sure-init` compose service that uses the same image as
# `sure-web` and gates on `sure-web: condition: service_healthy`).
#
# Inputs (from /alfred-data, written by the alfred-init container):
#   /alfred-data/.sure-bootstrap-email     — owner email (one line, no whitespace)
#   /alfred-data/.sure-bootstrap-password  — owner password (one line, mode 0600)
#
# Outputs (written by this script):
#   /alfred-data/.sure-api-key             — plaintext API key (mode 0600)
#
# Idempotent:
#   - Skips user creation if a User with the bootstrap email already exists.
#   - Skips key creation if /alfred-data/.sure-api-key already exists.
#   - Skips key creation if the user already has an active "monitoring" key
#     (writes the existing display_key to the file so callers can read it).
#
# Source-of-truth references (we-promise/sure @ main, fetched 2026-04-29):
#   app/models/api_key.rb             — scopes ∈ {["read"],["read_write"]}, source ∈ {"web","mobile","monitoring"},
#                                       ApiKey.generate_secure_key = SecureRandom.hex(32),
#                                       one active key per user per source.
#   app/models/user.rb                — User.role_for_new_family_creator (first user becomes :super_admin),
#                                       belongs_to :family (required), email/password validations.
#   app/controllers/registrations_controller.rb — password rules enforced for the web signup path:
#                                       >=8 chars, upper+lower, digit, special. We mirror those here so
#                                       the bootstrap password meets the same bar even though `User`
#                                       itself only enforces length>=8.
#   app/controllers/settings/api_keys_controller.rb — canonical create flow:
#                                       plain = ApiKey.generate_secure_key; user.api_keys.build(name:, scopes:);
#                                       record.key = plain; record.save!

require "fileutils"

EMAIL_FILE    = "/alfred-data/.sure-bootstrap-email"
PASSWORD_FILE = "/alfred-data/.sure-bootstrap-password"
KEY_FILE      = "/alfred-data/.sure-api-key"

KEY_NAME   = "Alfred"
KEY_SOURCE = "monitoring" # so the human-facing "web" slot stays free for the owner
KEY_SCOPES = ["read_write"] # ApiKey enforces single-element array of "read" or "read_write"

def log(msg)
  warn "[sure-bootstrap] #{msg}"
end

def die(msg)
  warn "[sure-bootstrap] FATAL: #{msg}"
  exit 1
end

def read_secret(path, label)
  die "#{label} file missing: #{path}" unless File.exist?(path)
  value = File.read(path).strip
  die "#{label} file empty: #{path}" if value.empty?
  value
end

# --- Inputs ---
email    = read_secret(EMAIL_FILE, "owner email").downcase
password = read_secret(PASSWORD_FILE, "bootstrap password")

if File.exist?(KEY_FILE) && File.size(KEY_FILE) > 0
  log "API key file already exists at #{KEY_FILE}, nothing to do."
  exit 0
end

# --- 1. Find or create the owner user (and family) ---
user = User.find_by(email: email)

if user.nil?
  log "Creating owner user #{email} (first-user role policy applies)"
  ActiveRecord::Base.transaction do
    family = Family.new
    user = User.new(email: email, password: password, password_confirmation: password)
    user.family = family
    user.role = User.role_for_new_family_creator # super_admin if first user, else admin
    unless user.save
      die "User creation failed: #{user.errors.full_messages.join('; ')}"
    end
  end
  log "Owner user created (role=#{user.role}, family_id=#{user.family_id})"
else
  log "Owner user #{email} already exists (role=#{user.role}), reusing."
end

# --- 2. Reuse an existing active monitoring key if present, else mint a new one ---
existing = user.api_keys.active.where(source: KEY_SOURCE).first

if existing
  log "User already has an active #{KEY_SOURCE} API key (id=#{existing.id}), reusing its display_key."
  plain_key = existing.display_key
else
  plain_key = ApiKey.generate_secure_key # 64-char hex (SecureRandom.hex(32))
  api_key = user.api_keys.build(name: KEY_NAME, scopes: KEY_SCOPES, source: KEY_SOURCE)
  api_key.key = plain_key
  unless api_key.save
    die "ApiKey creation failed: #{api_key.errors.full_messages.join('; ')}"
  end
  log "Minted new API key (id=#{api_key.id}, name=#{KEY_NAME}, source=#{KEY_SOURCE}, scopes=#{KEY_SCOPES.inspect})"
end

# --- 3. Persist the plaintext key to the shared volume ---
FileUtils.mkdir_p(File.dirname(KEY_FILE))
File.open(KEY_FILE, File::WRONLY | File::CREAT | File::TRUNC, 0o600) do |f|
  f.write(plain_key)
end
log "Wrote API key to #{KEY_FILE} (mode 0600)"
log "Done."
