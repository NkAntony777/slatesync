"""Import synthetic fixtures and test AutoSync in a NEW project only.
No existing project is modified, saved, or deleted. Leaves the test project for inspection.
"""
import argparse
import datetime
import json
import os
from pathlib import Path
import sys

parser = argparse.ArgumentParser()
parser.add_argument("--fixtures", default="test/artifacts/resolve")
parser.add_argument("--report", default="test/artifacts/resolve/resolve-report.json")
parser.add_argument("--resolve-dir", default=r"D:\game\dfq20 Win")
args = parser.parse_args()
modules = Path(os.environ.get("PROGRAMDATA", r"C:\ProgramData")) / "Blackmagic Design/DaVinci Resolve/Support/Developer/Scripting/Modules"
os.environ["RESOLVE_SCRIPT_LIB"] = str(Path(args.resolve_dir) / "fusionscript.dll")
sys.path.insert(0, str(modules))
import DaVinciResolveScript as dvr
resolve = dvr.scriptapp("Resolve")
if not resolve:
    raise SystemExit("Resolve API unavailable: start Resolve; if necessary enable local external scripting in Preferences.")
pm = resolve.GetProjectManager()
previous = pm.GetCurrentProject()
previous_name = previous.GetName() if previous else None
name = "AudioTC_Compatibility_" + datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
project = pm.CreateProject(name)
if not project:
    raise SystemExit("Could not create isolated verification project; nothing was changed.")
report = {"resolveVersion": resolve.GetVersionString(), "project": name, "previousProject": previous_name,
          "generatedAt": datetime.datetime.now().isoformat(), "source": "synthetic fixtures", "imports": {}, "sync": []}
try:
    project.SetSetting("timelineFrameRate", "25")
    project.SetSetting("timelinePlaybackFrameRate", "25")
    pool = project.GetMediaPool()
    fixtures = Path(args.fixtures).resolve()
    names = ["resolve_discrete4.wav", "resolve_iso2.wav", "sidus_ltc5.wav", "syncaila_ref.wav"]
    for filename in names:
        clips = pool.ImportMedia([str(fixtures / filename)]) or []
        if len(clips) != 1:
            report["imports"][filename] = {"ok": False, "reason": "expected exactly one imported clip"}
            continue
        clip = clips[0]
        report["imports"][filename] = {"ok": True, "properties": clip.GetClipProperty(),
                                      "audioMapping": json.loads(clip.GetAudioMapping())}
    # Separate folders prevent one test's linked audio from contaminating another test.
    for label, wav, mode, retain in [
        ("timecode_replace", "resolve_discrete4.wav", resolve.AUDIO_SYNC_TIMECODE, False),
        ("timecode_retain", "resolve_discrete4.wav", resolve.AUDIO_SYNC_TIMECODE, True),
        ("waveform_program_poly", "resolve_discrete4.wav", resolve.AUDIO_SYNC_WAVEFORM, False),
        ("waveform_mono_reference", "syncaila_ref.wav", resolve.AUDIO_SYNC_WAVEFORM, False),
    ]:
        folder = pool.AddSubFolder(pool.GetRootFolder(), label)
        pool.SetCurrentFolder(folder)
        clips = pool.ImportMedia([str(fixtures / "camera.mov"), str(fixtures / wav)]) or []
        settings = {resolve.AUDIO_SYNC_MODE: mode, resolve.AUDIO_SYNC_CHANNEL_NUMBER: 1,
                    resolve.AUDIO_SYNC_RETAIN_EMBEDDED_AUDIO: retain,
                    resolve.AUDIO_SYNC_RETAIN_VIDEO_METADATA: True}
        ok = bool(len(clips) == 2 and pool.AutoSyncAudio(clips, settings))
        video = next((clip for clip in clips if clip.GetName().lower().endswith(".mov")), None)
        report["sync"].append({"test": label, "ok": ok, "retainedCameraAudio": retain,
                               "videoProperties": video.GetClipProperty() if video else None,
                               "audioMapping": json.loads(video.GetAudioMapping()) if video else None})
    checks = []
    for filename, channels in [("resolve_discrete4.wav", 4), ("resolve_iso2.wav", 2), ("sidus_ltc5.wav", 5), ("syncaila_ref.wav", 1)]:
        item = report["imports"][filename]
        mapping = item.get("audioMapping", {})
        checks.append({"test": f"{filename}: channel count", "ok": mapping.get("embedded_audio_channels") == channels})
        checks.append({"test": f"{filename}: timecode", "ok": item.get("properties", {}).get("Start TC") == "01:00:00:00"})
        indices = [index for track in mapping.get("track_mapping", {}).values() for index in track.get("channel_idx", [])]
        checks.append({"test": f"{filename}: contiguous mapping", "ok": indices == list(range(1, channels + 1))})
    for item in report["sync"]:
        mapping = item.get("audioMapping") or {}
        linked = list(mapping.get("linked_audio", {}).values())
        expected_channels = 1 if item["test"] == "waveform_mono_reference" else 4
        indices = [index for track in mapping.get("track_mapping", {}).values() for index in track.get("channel_idx", [])]
        expected_indices = list(range(1 if item["retainedCameraAudio"] else 2, expected_channels + 2))
        checks.append({"test": item["test"] + ": linked source and zero offset", "ok": bool(item["ok"] and len(linked) == 1 and linked[0].get("channels") == expected_channels and linked[0].get("offset") == 0)})
        checks.append({"test": item["test"] + ": only expected tracks", "ok": indices == expected_indices and all(not track.get("mute", False) for track in mapping.get("track_mapping", {}).values())})
    report["checks"] = checks
    report["allChecksPassed"] = all(check["ok"] for check in checks)
    pm.SaveProject()
finally:
    report_path = Path(args.report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    # Keep the verification project in the project library. Restore the previous project.
    if previous_name:
        pm.LoadProject(previous_name)
print(json.dumps({"report": str(Path(args.report).resolve()), "project": name,
                  "allChecksPassed": report.get("allChecksPassed", False), "importsOk": all(item["ok"] for item in report["imports"].values()),
                  "sync": [{"test": item["test"], "ok": item["ok"]} for item in report["sync"]]}, ensure_ascii=False, indent=2))

if not report.get("allChecksPassed", False):
    raise SystemExit(1)
