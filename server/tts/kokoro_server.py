"""
Long-lived Kokoro TTS worker: loads the ONNX model + voice pack ONCE, then
serves synthesis requests over stdin/stdout as newline-delimited JSON so the
Node process never pays the multi-second model-load cost per paragraph.

Protocol:
  stdin  <- {"id": "...", "text": "...", "voice": "af_heart", "speed": 1.0}\n
  stdout -> {"id": "...", "success": true, "audio": "<base64 wav>"}\n
         or {"id": "...", "success": false, "error": "..."}\n
  On boot, prints {"ready": true} once the model is loaded.
"""
import sys
import json
import base64
import io
import warnings

warnings.filterwarnings("ignore")


def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 3:
        emit({"ready": False, "error": "Thiếu đường dẫn model/voices."})
        sys.exit(1)

    model_path, voices_path = sys.argv[1], sys.argv[2]

    try:
        from kokoro_onnx import Kokoro
        import soundfile as sf
    except ImportError as e:
        emit({"ready": False, "error": f"Thiếu thư viện Python: {e}"})
        sys.exit(1)

    try:
        kokoro = Kokoro(model_path, voices_path)
    except Exception as e:
        emit({"ready": False, "error": f"Không tải được model Kokoro: {e}"})
        sys.exit(1)

    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get("id")
            text = req["text"]
            voice = req.get("voice") or "af_heart"
            speed = float(req.get("speed") or 1.0)
            lang = req.get("lang") or "en-us"

            samples, sample_rate = kokoro.create(text, voice=voice, speed=speed, lang=lang)
            buffer = io.BytesIO()
            sf.write(buffer, samples, sample_rate, format="WAV")
            audio_b64 = base64.b64encode(buffer.getvalue()).decode("utf-8")
            emit({"id": req_id, "success": True, "audio": audio_b64})
        except Exception as e:
            emit({"id": req_id, "success": False, "error": str(e)})


if __name__ == "__main__":
    main()
