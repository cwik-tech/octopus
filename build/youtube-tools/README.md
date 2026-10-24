# YouTube media tools

Release packaging populates this directory with one verified directory per
currently declared application target (`darwin-arm64` and `darwin-x64`). Each
target contains pinned `yt-dlp`, `ffmpeg`, and `ffprobe` executables plus the
checksum manifest consumed by the application. The manifest/staging format is
portable, but adding Windows or Linux is a separate packaging decision.

The application does not search the host `PATH` or self-update these tools.
