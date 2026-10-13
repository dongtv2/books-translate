#!/usr/bin/env python3
"""Long-lived worker bridging the Node backend to NVIDIA's cloud-hosted Riva
NMT service over gRPC, via the `nvidia-riva-client` package. Mirrors the
Kokoro TTS worker's protocol exactly: one JSON object per line on stdin,
one JSON object per line on stdout, so server/riva/rivaProcess.js can reuse
the same request/response pattern as server/tts/kokoroProcess.js.

Usage: python3 riva_nmt_server.py <api_key> <function_id> <grpc_server>

stdin  (one per line): {"id": "...", "text": "...", "sourceLang": "en", "targetLang": "vi"}
stdout (one per line): {"id": "...", "success": true, "translation": "..."}
                    or {"id": "...", "success": false, "error": "..."}
On startup: {"ready": true} once the auth/client is set up, or
            {"ready": false, "error": "..."} if it couldn't be.
"""
import os
import sys
import json

def emit(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

def main():
    # The API key comes through the environment (RIVA_API_KEY), not the
    # command line, where other users of the machine could read it with ps.
    api_key = os.environ.get("RIVA_API_KEY", "")
    if len(sys.argv) < 3 or not api_key:
        emit({"ready": False, "error": "Thiếu tham số: RIVA_API_KEY, function_id, grpc_server."})
        return

    function_id, grpc_server = sys.argv[1], sys.argv[2]

    try:
        import riva.client
    except ImportError as e:
        emit({"ready": False, "error": f"Chưa cài nvidia-riva-client (pip install nvidia-riva-client): {e}"})
        return

    try:
        auth = riva.client.Auth(
            uri=grpc_server,
            use_ssl=True,
            metadata_args=[["function-id", function_id], ["authorization", f"Bearer {api_key}"]],
        )
        nmt_client = riva.client.NeuralMachineTranslationClient(auth)
    except Exception as e:
        emit({"ready": False, "error": f"Không khởi tạo được Riva NMT client: {e}"})
        return

    emit({"ready": True})

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            continue

        req_id = req.get("id")
        try:
            text = req.get("text", "")
            source_lang = req.get("sourceLang", "en")
            target_lang = req.get("targetLang", "vi")
            if not text.strip():
                raise ValueError("Thiếu nội dung cần dịch.")

            response = nmt_client.translate([text], "", source_lang, target_lang)
            translation = response.translations[0].text
            emit({"id": req_id, "success": True, "translation": translation})
        except Exception as e:
            emit({"id": req_id, "success": False, "error": str(e)})

if __name__ == "__main__":
    main()
