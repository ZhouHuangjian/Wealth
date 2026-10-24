from django.urls import path, re_path
from django.views.generic import TemplateView
from wealth.views import api, health
from wealth.chat import device_check, ingest
from wealth.chat_remote import device_poll
from wealth.chat_history import device_history

urlpatterns = [
    path("api/health/", health),
    path("api/v1/health", health),
    re_path(r"^api/v1/chat/ingest/?$", ingest),
    re_path(r"^api/v1/chat/device/check/?$", device_check),
    re_path(r"^api/v1/chat/device/poll/?$", device_poll),
    re_path(r"^api/v1/chat/device/history/?$", device_history),
    re_path(r"^api/v1/(?P<route>.*?)/?$", api),
    re_path(
        r"^(?!api/|static/|assets/).*$",
        TemplateView.as_view(template_name="index.html"),
    ),
]
