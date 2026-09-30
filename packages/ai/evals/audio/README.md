Drop real recordings here (ogg/opus, m4a, wav, mp3), named as `audioFile` in ../data/asr.json, to run WER evals against a
live provider (`ASR_PROVIDER=sarvam SARVAM_API_KEY=... pnpm --filter @cnote/ai eval`). Without files or a key the ASR live
evals are skipped; the mock ASR only validates the harness plumbing (WER 0 on sidecar transcripts).
