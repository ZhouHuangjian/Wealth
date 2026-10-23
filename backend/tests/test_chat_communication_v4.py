"""Rich analysis remains strict and backward compatible across cloud transports."""

from copy import deepcopy

import pytest
from test_chat_remote_current import message
from test_chat_remote_v2 import profile
from wealth.chat_history import validate_message
from wealth.chat_remote import (
    DomainError,
    memory_entry_values,
    validate_current_message,
    validate_processing,
    validate_profile,
)


def rich_message():
    result = message()
    result["id"] = "11111111-1111-4111-8111-111111111111"
    analysis = result["analysis"]
    analysis["emotions"] = [
        {"label": "关切", "percentage": 80},
        {"label": "平静", "percentage": 20},
    ]
    analysis["rubricVersion"] = "xiangzhi-communication-v4"
    analysis["affinity"].update(
        {
            "coverage": 100,
            "dimensions": [
                {"key": key, "score": 60, "evidenceMessageIds": [result["id"]]}
                for key in [
                    "initiative",
                    "engagement",
                    "care",
                    "openness",
                    "closeness",
                    "action",
                ]
            ],
        }
    )
    return result


def test_legacy_and_rich_analysis_validate_in_current_and_full_history():
    validate_current_message(message())
    rich = rich_message()
    validate_current_message(rich)
    rich["analysis"]["stale"] = True
    validate_message(rich)
    own = rich_message()
    own["role"] = "self"
    own["analysis"]["affinity"] = None
    own["analysis"]["intents"] = []
    own["analysis"]["emotions"] = []
    own["analysis"]["replyReview"] = {
        "score": 80,
        "summary": "接住当时的话题。",
        "criteria": [
            {"key": key, "score": 80, "evidenceMessageIds": [own["id"]]}
            for key in ["style", "relevance", "clarity", "factuality"]
        ],
    }
    validate_current_message(own)


@pytest.mark.parametrize(
    "change",
    [
        lambda a: a["emotions"][0].update(percentage=20),
        lambda a: a["emotions"][0].update(label="心理诊断"),
        lambda a: a["affinity"]["dimensions"][0].update(key="care"),
        lambda a: a["affinity"]["dimensions"][0].update(score=True),
        lambda a: a["affinity"]["dimensions"][0].update(evidenceMessageIds=[]),
        lambda a: a["affinity"].update(coverage=101),
        lambda a: a.update(rubricVersion="Bearer private-secret"),
    ],
)
def test_cloud_rejects_malformed_rich_analysis(change):
    item = rich_message()
    change(item["analysis"])
    with pytest.raises(DomainError):
        validate_current_message(item)


def test_contact_flags_and_event_state_remain_optional_and_independent():
    validate_processing(
        {"emotionEnabled": True, "replyReviewEnabled": False}, patch=True
    )
    with pytest.raises(DomainError):
        validate_processing({"emotionEnabled": "true"}, patch=True)
    event = {
        "kind": "invitation",
        "state": "resolved",
        "resolvedByMessageIds": ["later_message"],
    }
    memory_entry_values({"event": event}, patch=True)
    body = profile()
    entry = body["memory"]["entries"][0]
    entry.update(kind="event", event=event)
    assert validate_profile(body)["memory"]["entries"][0]["event"] == event
    bad = deepcopy(body)
    bad["memory"]["entries"][0]["event"]["resolvedByMessageIds"] = ["same", "same"]
    with pytest.raises(DomainError):
        validate_profile(bad)
    with pytest.raises(DomainError):
        memory_entry_values({"kind": "fact", "event": event}, patch=True)
