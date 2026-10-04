import os
from pathlib import Path
import dj_database_url

BASE_DIR = Path(__file__).resolve().parent.parent
DEBUG = os.getenv("DEBUG", os.getenv("DJANGO_DEBUG", "0")) == "1"
SECRET_KEY = os.environ.get("SECRET_KEY", os.environ.get("DJANGO_SECRET_KEY", ""))
if not SECRET_KEY:
    if DEBUG or os.environ.get("PYTEST_CURRENT_TEST") or os.getenv("WEALTH_TESTING"):
        SECRET_KEY = "local-tests-only-not-for-production-change-me"
    else:
        raise RuntimeError("SECRET_KEY must be configured")
ALLOWED_HOSTS = os.getenv(
    "ALLOWED_HOSTS", os.getenv("DJANGO_ALLOWED_HOSTS", "localhost,127.0.0.1,testserver")
).split(",")
INSTALLED_APPS = [
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.staticfiles",
    "rest_framework",
    "drf_spectacular",
    "wealth",
]
MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "whitenoise.middleware.WhiteNoiseMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]
ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR.parent / "frontend/dist"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": ["django.template.context_processors.request"]
        },
    }
]
DATABASES = {
    "default": dj_database_url.parse(
        os.environ.get(
            "DATABASE_URL",
            "postgresql://wealth_app:wealth_local@127.0.0.1:55432/wealth",
        ),
        conn_max_age=0,
    )
}
if os.getenv("DATABASE_URL_ADMIN") and any(
    x in __import__("sys").argv for x in ["migrate", "makemigrations"]
):
    DATABASES["default"] = dj_database_url.parse(os.environ["DATABASE_URL_ADMIN"])
LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_TZ = True
DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
AUTH_PASSWORD_VALIDATORS = [
    {
        "NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
        "OPTIONS": {"min_length": 10},
    },
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]
SESSION_COOKIE_HTTPONLY = True
SESSION_COOKIE_SAMESITE = "Lax"
SESSION_COOKIE_SECURE = not DEBUG
CSRF_COOKIE_SECURE = not DEBUG
CSRF_TRUSTED_ORIGINS = [
    x
    for x in os.getenv(
        "CSRF_TRUSTED_ORIGINS",
        os.getenv(
            "DJANGO_CSRF_TRUSTED_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173"
        ),
    ).split(",")
    if x
]
SECURE_CONTENT_TYPE_NOSNIFF = True
SECURE_REFERRER_POLICY = "same-origin"
X_FRAME_OPTIONS = "DENY"
# Enable only when the application port is private and the controlled reverse
# proxy replaces, rather than forwards, the client's X-Forwarded-Proto header.
SECURE_PROXY_SSL_HEADER = (
    ("HTTP_X_FORWARDED_PROTO", "https")
    if os.getenv("WEALTH_TRUST_PROXY", "0") == "1"
    else None
)
SECURE_SSL_REDIRECT = os.getenv("WEALTH_FORCE_HTTPS", "0") == "1"
# Container probes use loopback HTTP and expose no account or financial data.
SECURE_REDIRECT_EXEMPT = [r"^api/health/?$", r"^api/v1/health/?$"]
SECURE_HSTS_SECONDS = int(os.getenv("WEALTH_HSTS_SECONDS", "0"))
if SECURE_HSTS_SECONDS < 0:
    raise RuntimeError("WEALTH_HSTS_SECONDS must be nonnegative")
# A server-IP deployment has no subdomains and cannot use the preload list.
SECURE_HSTS_INCLUDE_SUBDOMAINS = False
SECURE_HSTS_PRELOAD = False
APPEND_SLASH = False
DATA_UPLOAD_MAX_MEMORY_SIZE = 12 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 2 * 1024 * 1024
PRIVATE_MEDIA_ROOT = Path(
    os.getenv("PRIVATE_MEDIA_ROOT", str(BASE_DIR.parent / ".private-media"))
)
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"
WHITENOISE_ROOT = BASE_DIR.parent / "frontend/dist"
STORAGES = {
    "default": {"BACKEND": "django.core.files.storage.FileSystemStorage"},
    "staticfiles": {"BACKEND": "whitenoise.storage.CompressedStaticFilesStorage"},
}
REST_FRAMEWORK = {
    "DEFAULT_AUTHENTICATION_CLASSES": [
        "rest_framework.authentication.SessionAuthentication"
    ],
    "DEFAULT_PERMISSION_CLASSES": ["rest_framework.permissions.IsAuthenticated"],
    "DEFAULT_SCHEMA_CLASS": "drf_spectacular.openapi.AutoSchema",
    "COERCE_DECIMAL_TO_STRING": True,
}
SPECTACULAR_SETTINGS = {
    "TITLE": "Wealth API",
    "VERSION": "2.9.1",
    "SERVE_INCLUDE_SCHEMA": False,
}
CELERY_BROKER_URL = os.getenv(
    "CELERY_BROKER_URL", "amqp://guest:guest@127.0.0.1:5672//"
)
CELERY_TASK_SERIALIZER = "json"
CELERY_ACCEPT_CONTENT = ["json"]
# RabbitMQ 4.3 rejects non-durable, non-exclusive queues. Control replies and
# event subscriptions belong to one connection and should disappear with it.
CELERY_CONTROL_QUEUE_EXCLUSIVE = True
CELERY_EVENT_QUEUE_EXCLUSIVE = True
# Quorum task queues also make Celery disable the global QoS mode that RabbitMQ
# 4.3 no longer permits. Use a new name to avoid redeclaring a classic queue.
CELERY_TASK_DEFAULT_QUEUE = "wealth.tasks"
CELERY_TASK_DEFAULT_QUEUE_TYPE = "quorum"
CELERY_TASK_CREATE_MISSING_QUEUE_TYPE = "quorum"
CELERY_WORKER_DETECT_QUORUM_QUEUES = True
CELERY_BROKER_TRANSPORT_OPTIONS = {"confirm_publish": True}
CELERY_BROKER_CONNECTION_TIMEOUT = 4
CELERY_TASK_ACKS_LATE = True
CELERY_TASK_REJECT_ON_WORKER_LOST = True
CELERY_TASK_TIME_LIMIT = 300
CELERY_BEAT_SCHEDULE = {
    "refresh-dividends": {
        "task": "wealth.tasks.refresh_dividends_all",
        "schedule": 3600.0,
    },
    "dispatch-outbox": {"task": "wealth.tasks.dispatch_all", "schedule": 30.0},
    "scan-due": {"task": "wealth.tasks.scan_all", "schedule": 300.0},
    "refresh-market": {"task": "wealth.tasks.refresh_market_all", "schedule": 300.0},
    "evaluate-signals": {
        "task": "wealth.tasks.evaluate_signals_all",
        "schedule": 300.0,
    },
    "refresh-market-catalog": {
        "task": "wealth.tasks.refresh_market_catalog",
        "schedule": 86400.0,
    },
}
WEALTH_MARKET_DATA_ENABLED = (
    os.getenv("WEALTH_MARKET_DATA_ENABLED", "0" if os.getenv("WEALTH_TESTING") else "1")
    == "1"
)
WEALTH_MARKET_INLINE = os.getenv("WEALTH_MARKET_INLINE", "0") == "1"
