# Plane first-boot admin auto-seed (Sir #6, 2026-05-24).
#
# Run via `python manage.py shell -c "exec(open(...).read())"` from the
# `plane-init` one-shot service (image: makeplane/plane-backend:stable,
# same as plane-api so Django settings + DB env are on PYTHONPATH).
#
# We bypass the /api/instances/admins/sign-up/ HTTP path because it's a
# Django View guarded by CSRF middleware — going straight to the ORM is
# simpler, atomic, and matches the create_instance_admin mgmt command.
#
# Inputs: OWNER_EMAIL (or /alfred-data/.plane-bootstrap-email),
#         PLANE_BOOTSTRAP_PASSWORD (or /alfred-data/.plane-bootstrap-password).
# Output: /alfred-data/.plane-admin-password (renamed from bootstrap file).
# Idempotent: exits 0 if is_setup_done already True.

import os
import sys
import uuid

EMAIL_FILE = "/alfred-data/.plane-bootstrap-email"
PW_FILE = "/alfred-data/.plane-bootstrap-password"
DONE_FILE = "/alfred-data/.plane-admin-password"


def log(msg):
    print(f"[plane-bootstrap] {msg}", flush=True)


def die(msg, code=1):
    print(f"[plane-bootstrap] FATAL: {msg}", flush=True)
    sys.exit(code)


def read_file(path):
    try:
        with open(path) as f:
            return f.read().strip()
    except OSError:
        return ""


from django.contrib.auth.hashers import make_password
from django.utils import timezone

from plane.db.models import Profile, User
from plane.license.models import Instance, InstanceAdmin

# --- Inputs ---
email = (os.environ.get("OWNER_EMAIL") or read_file(EMAIL_FILE)).strip().lower()
if not email:
    die(f"OWNER_EMAIL unset and {EMAIL_FILE} missing/empty")

password = os.environ.get("PLANE_BOOTSTRAP_PASSWORD") or read_file(PW_FILE)
if not password:
    die(f"PLANE_BOOTSTRAP_PASSWORD unset and {PW_FILE} missing/empty")

first_name = os.environ.get("OWNER_FIRST_NAME", "Alfred")
last_name = os.environ.get("OWNER_LAST_NAME", "Owner")
company_name = os.environ.get("OWNER_COMPANY", "Alfred Black")

# --- 1. Instance must already be registered (plane-migrator does this). ---
instance = Instance.objects.first()
if instance is None:
    die("Plane Instance row not found — plane-migrator hasn't run register_instance yet?")

# --- 2. Already done? Short-circuit. ---
if instance.is_setup_done:
    log("Plane instance already setup (is_setup_done=True). Nothing to do.")
    if os.path.exists(PW_FILE) and not os.path.exists(DONE_FILE):
        try:
            os.rename(PW_FILE, DONE_FILE)
            os.chmod(DONE_FILE, 0o600)
        except OSError:
            pass
    sys.exit(0)

# --- 3. Create or fetch owner user. ---
user = User.objects.filter(email=email).first()
if user is None:
    log(f"Creating owner user for {email}...")
    user = User.objects.create(
        first_name=first_name,
        last_name=last_name,
        email=email,
        username=uuid.uuid4().hex,
        password=make_password(password),
        is_password_autoset=False,
        is_active=True,
        last_active=timezone.now(),
        token_updated_at=timezone.now(),
    )
    Profile.objects.create(user=user, company_name=company_name)
    log(f"Owner user created (id={user.id})")
else:
    log(f"Owner user already exists (id={user.id}); not overwriting password")
    if not user.is_active:
        user.is_active = True
        user.save(update_fields=["is_active"])

# --- 4. Ensure InstanceAdmin link. ---
admin, created = InstanceAdmin.objects.get_or_create(
    user=user,
    instance=instance,
    defaults={"role": 20},
)
log(f"InstanceAdmin {'created' if created else 'already existed'} (id={admin.id})")

# --- 5. Mark instance as set up. ---
instance.is_setup_done = True
instance.is_signup_screen_visited = True
if not instance.instance_name or instance.instance_name == "Plane Community Edition":
    instance.instance_name = company_name
instance.is_telemetry_enabled = False
instance.save(update_fields=[
    "is_setup_done",
    "is_signup_screen_visited",
    "instance_name",
    "is_telemetry_enabled",
])
log(f"Instance marked setup_done=True, name={instance.instance_name}")

# --- 6. Move the password file to the "done" name so we know we finished. ---
if os.path.exists(PW_FILE):
    try:
        os.rename(PW_FILE, DONE_FILE)
        os.chmod(DONE_FILE, 0o600)
        log(f"Owner password preserved at {DONE_FILE}")
    except OSError as e:
        log(f"warning: could not rename password file: {e}")

log("Plane admin auto-seed complete.")
