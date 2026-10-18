from app.policy import DefectScores, RestorationEvidence, choose_restoration


def clean_scores(**overrides: float) -> DefectScores:
    values = {
        "shadow": 0.1,
        "curved": 0.1,
        "blur": 0.1,
        "moire": 0.1,
        "finger": 0.1,
        "low_contrast": 0.1,
        "color_document": 0.1,
    }
    values.update(overrides)
    return DefectScores(**values)


def test_clean_document_stays_local() -> None:
    decision = choose_restoration(clean_scores(), RestorationEvidence(12, 0.1, "high"))

    assert decision.route == "local"
    assert decision.stages == ()


def test_stages_have_stable_quality_order() -> None:
    decision = choose_restoration(
        clean_scores(
            finger=0.9,
            curved=0.9,
            shadow=0.9,
            moire=0.9,
            blur=0.9,
            low_contrast=0.9,
        ),
        RestorationEvidence(40, 0.1, "low"),
    )

    assert decision.stages == (
        "finger-segmentation",
        "dewarp",
        "deshadow",
        "demoire",
        "deblur",
        "appearance",
    )


def test_medium_scores_require_classical_confirmation() -> None:
    scores = clean_scores(shadow=0.6, blur=0.6)

    confirmed = choose_restoration(scores, RestorationEvidence(25, 0.1, "low"))
    rejected = choose_restoration(scores, RestorationEvidence(10, 0.1, "high"))

    assert confirmed.stages == ("deshadow", "deblur")
    assert rejected.route == "local"


def test_color_documents_are_marked_for_color_protection() -> None:
    decision = choose_restoration(
        clean_scores(low_contrast=0.9, color_document=0.8),
        RestorationEvidence(10, 0.1, "high"),
    )

    assert decision.protect_color is True

