from django.urls import path, re_path
from django.views.generic import TemplateView
from wealth.views import api, health

urlpatterns = [
    path("api/health/", health),
    path("api/v1/health", health),
    re_path(r"^api/v1/(?P<route>.*?)/?$", api),
    re_path(
        r"^(?!api/|static/|assets/).*$",
        TemplateView.as_view(template_name="index.html"),
    ),
]
