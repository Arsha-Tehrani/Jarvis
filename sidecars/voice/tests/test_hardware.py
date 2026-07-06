"""The compute decision matrix: CUDA when NVIDIA, honest CPU fallback for
AMD/Apple/none, env overrides always win."""

from voice.hardware import choose_compute, detect


def test_nvidia_gets_cuda_float16():
    choice = choose_compute(nvidia=True, amd=False, apple=False)
    assert (choice.device, choice.compute_type) == ("cuda", "float16")
    assert "NVIDIA" in choice.reason


def test_amd_falls_back_to_cpu_and_says_why():
    choice = choose_compute(nvidia=False, amd=True, apple=False)
    assert (choice.device, choice.compute_type) == ("cpu", "int8")
    assert "NO clean native AMD GPU path" in choice.reason
    assert "ROCm" in choice.reason


def test_apple_silicon_is_cpu_with_note():
    choice = choose_compute(nvidia=False, amd=False, apple=True)
    assert (choice.device, choice.compute_type) == ("cpu", "int8")
    assert "Apple Silicon" in choice.reason
    assert "no Metal" in choice.reason


def test_no_gpu_defaults_to_cpu_int8():
    choice = choose_compute(nvidia=False, amd=False, apple=False)
    assert (choice.device, choice.compute_type) == ("cpu", "int8")


def test_nvidia_beats_amd_when_both_present():
    assert choose_compute(nvidia=True, amd=True, apple=False).device == "cuda"


def test_env_device_override_wins_over_detection():
    choice = choose_compute(nvidia=True, amd=False, apple=False, env_device="cpu")
    assert (choice.device, choice.compute_type) == ("cpu", "int8")
    assert "override" in choice.reason
    forced_cuda = choose_compute(nvidia=False, amd=True, apple=False, env_device="cuda")
    assert (forced_cuda.device, forced_cuda.compute_type) == ("cuda", "float16")


def test_env_compute_override_applies_on_both_paths():
    assert choose_compute(True, False, False, env_compute="int8_float16").compute_type == "int8_float16"
    assert choose_compute(False, False, False, env_compute="float32").compute_type == "float32"


def test_live_detect_returns_a_usable_choice():
    # Exercises the real probes on this machine (whatever it is) — must not
    # raise, and must land on a valid device either way.
    choice = detect()
    assert choice.device in ("cuda", "cpu")
    assert choice.compute_type
    assert choice.reason
