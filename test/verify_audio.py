"""Inspect actual browser downloads against the generated 440/660/880 Hz fixture."""
import json
import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np

source = Path(sys.argv[1])
destination = Path(__file__).resolve().parent / "results"
destination.mkdir(exist_ok=True)
if source.suffix.lower() == ".zip":
    expected = {"荷叶_范读.mp3": 660, "荷叶_范读_2.mp3": 880}
    with zipfile.ZipFile(source) as archive:
        assert set(archive.namelist()) == set(expected), archive.namelist()
        for name in archive.namelist():
            assert Path(name).name == name
            (destination / name).write_bytes(archive.read(name))
    paths = [(destination / name, frequency) for name, frequency in expected.items()]
else:
    paths = [(source, 880)]
report = []
for path, expected_frequency in paths:
    meta = json.loads(subprocess.check_output(["ffprobe", "-v", "error", "-show_entries", "format=duration:stream=codec_name,sample_rate", "-of", "json", str(path)]))
    duration = float(meta["format"]["duration"])
    assert abs(duration - 4) < (0.002 if path.suffix.lower() == ".wav" else 0.1), duration
    audio = subprocess.check_output(["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", str(path), "-f", "f32le", "-ac", "1", "-ar", "44100", "-"])
    samples = np.frombuffer(audio, dtype="<f4")[44100:88200]
    spectrum = np.abs(np.fft.rfft(samples))
    frequency = float(np.fft.rfftfreq(samples.size, 1 / 44100)[spectrum.argmax()])
    assert abs(frequency - expected_frequency) < 2, (path.name, frequency)
    report.append({"filename": path.name, "seconds": duration, "dominant_hz": frequency, "codec": meta["streams"][0]["codec_name"]})
print(json.dumps(report, ensure_ascii=False, indent=2))
(destination / ("wav-report.json" if source.suffix.lower() == ".wav" else "mp3-zip-report.json")).write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
