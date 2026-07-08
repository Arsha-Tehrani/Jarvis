"""Provider-ladder decision matrix for the onnx backend — pure function
over a probed provider list, no onnxruntime install needed (same testing
pattern as hardware.choose_compute)."""

from voice.onnx_transcriber import hf_model_id, select_providers


def test_nvidia_wins_when_cuda_available():
    # onnxruntime-gpu on an NVIDIA box
    assert select_providers(
        ["CUDAExecutionProvider", "CPUExecutionProvider"]
    ) == ["CUDAExecutionProvider", "CPUExecutionProvider"]


def test_directml_wins_on_amd_windows():
    # onnxruntime-directml on the AMD/Windows box
    assert select_providers(
        ["DmlExecutionProvider", "CPUExecutionProvider"]
    ) == ["DmlExecutionProvider", "CPUExecutionProvider"]


def test_cuda_outranks_directml_if_both_present():
    assert select_providers(
        ["DmlExecutionProvider", "CUDAExecutionProvider", "CPUExecutionProvider"]
    )[0] == "CUDAExecutionProvider"


def test_cpu_only_build_falls_back_to_cpu():
    assert select_providers(["CPUExecutionProvider"]) == ["CPUExecutionProvider"]


def test_unknown_providers_ignored_and_cpu_always_appended():
    # e.g. a build advertising only an EP we don't rank
    assert select_providers(["CoreMLExecutionProvider"]) == ["CPUExecutionProvider"]


def test_model_name_mapping():
    assert hf_model_id("large-v3-turbo") == "openai/whisper-large-v3-turbo"
    assert hf_model_id("openai/whisper-small") == "openai/whisper-small"
