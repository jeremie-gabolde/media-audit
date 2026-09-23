# Media Audit

Media Audit scans a Downloads, Movies, and Series library for duplicate video files and hardlinks. It provides a small Flask web interface for reviewing findings and fixing them without copying media unnecessarily.

## Features

- Scans video files under Downloads, Movies, and Series.
- Detects duplicate content using size and sampled hashing.
- Detects files sharing the same inode and reports hardlink groups.
- Replaces a Movies or Series file with a hardlink to its Downloads source.
- Removes a confirmed duplicate from Downloads.
- Runs periodic background scans.
- Stores scan results, history, and hash cache as JSON.

## Requirements

- Docker Engine with Docker Compose.
- Downloads, Movies, and Series on the same filesystem if hardlinks are required.
- Read/write access to the media directories.
- The host path mounted into the container as one common parent directory.

Hardlinks cannot cross filesystem boundaries. The included Compose configuration mounts `/volume1/Media` as `/media`, so the application sees:

```text
/media/Downloads
/media/Movies
/media/Series
```

## Docker Setup

Build and start the application:

```bash
docker compose up -d --build
```

Create a local `.env` file before starting the container. It is ignored by Git:

```dotenv
MEDIA_AUDIT_USERNAME=your-username
MEDIA_AUDIT_PASSWORD=use-a-long-unique-password
```

Open the web interface at:

```text
http://NAS-IP:8080
```

The web page, API, and static assets require these credentials through HTTP Basic Authentication. Your browser will prompt for them when opening the page.

The default Compose configuration uses `${MEDIA_ROOT:-/volume1/Media}` and expects this host layout:

```text
/volume1/Media/Downloads
/volume1/Media/Movies
/volume1/Media/Series
```

Set `MEDIA_ROOT` in the shell or a local `.env` file if your NAS path differs:

```bash
MEDIA_ROOT=/your/media/share docker compose up -d --build
```

## Permissions

The container must be able to read Downloads and write Movies and Series. On Synology, grant the Docker service account or configured container user read/write access to the shared Media folder and ensure permissions are inherited by its subdirectories.

Verify the container sees the expected paths:

```bash
docker exec media-audit ls -ld /media /media/Downloads /media/Movies /media/Series
```

Verify that all directories are on the same device:

```bash
docker exec media-audit stat -c '%d %n' \
  /media/Downloads /media/Movies /media/Series
```

The device numbers must match for hardlinks to work.

## Using The Web Interface

1. Start a scan with **Run Scan**.
2. Leave **Show all files** unchecked to display only findings.
3. Press **Fix** for a duplicate or hardlink finding.
4. Choose one of the available actions:
   - **Replace with Downloads hardlink** keeps the library filename while sharing the same file data.
   - **Remove Downloads file** deletes the selected source from Downloads.
5. Run another scan after large batches of changes to refresh all counts.

The removal action is restricted to paths inside `/media/Downloads`. Hardlink replacement is restricted to `/media/Movies` and `/media/Series`.

## Configuration

Configuration is provided through environment variables in `docker-compose.yml`:

| Variable | Default | Description |
| --- | --- | --- |
| `SCAN_ROOTS` | `/media/Downloads,/media/Movies,/media/Series` | Comma-separated directories to scan |
| `SCAN_INTERVAL_DAYS` | `7` | Background scan interval |
| `DOWNLOADS_DIR` | `/media/Downloads` | Downloads directory used for fix operations |
| `MEDIA_ROOT` | `/volume1/Media` | Host directory mounted as `/media` by Compose |

## Troubleshooting

### Invalid cross-device link

An error such as this means the source and target are on different filesystems:

```text
[Errno 18] Invalid cross-device link
```

Mount the common host parent directory instead of separate bind mounts, then recreate the container:

```bash
docker compose up -d --force-recreate
```

### Confirm a hardlink

On the host or inside the container, compare device and inode values:

```bash
stat -c 'device=%d inode=%i links=%h path=%n' \
  /media/Downloads/source-file.mkv \
  /media/Movies/library-file.mkv
```

Both paths should have the same device and inode. The link count should be at least `2`.

### View application logs

```bash
docker logs -f media-audit
```

Browser-side fix errors are available in the browser developer console.

### Restore qBittorrent torrents

This project no longer integrates with qBittorrent, Sonarr, or Radarr. Those services should be managed separately. qBittorrent torrent metadata is normally stored in its `BT_backup` directory; re-adding those `.torrent` files and forcing a recheck can restore torrents without downloading existing data again.

## Development

Run the application locally after installing dependencies:

```bash
python -m pip install -r requirements.txt
python app.py
```

Run basic syntax checks:

```bash
python -m py_compile app.py fixer.py scanner.py
node --check static/app.js
```

Runtime scan data is stored in `data/` and is excluded from Docker build contexts by `.dockerignore`.

## Security

The web interface uses HTTP Basic Authentication configured through `MEDIA_AUDIT_USERNAME` and `MEDIA_AUDIT_PASSWORD`. Do not expose port `8080` directly to the public internet because Basic Authentication is not encrypted without HTTPS. Restrict access with a firewall, reverse proxy HTTPS, or a private network/VPN.

The application has read/write access to the mounted media directory because hardlink replacement and Downloads removal are destructive filesystem operations. Use a dedicated container and least-privilege filesystem permissions where possible.
