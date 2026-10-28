# Lists the tracks of a Spotify playlist or album using the spotdl install
# already present on this machine, with spotdl's own configuration.
#
# Why this exists: Spotify refuses playlist track listings to developer apps
# registered after its late-2024 policy change, which includes Crate's. The
# public embed shows only the first 100. spotdl holds an older registration
# that is still permitted, so when the user already has spotdl installed it
# can read a playlist of any length.
#
# Metadata only — this never touches audio. Crate finds and downloads the
# audio itself, tags it, and files it.
#
#   python scripts/spotdl-list.py <spotify url>
#   -> {"ok": true, "name": "...", "total": 412, "tracks": [...]}
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj))
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        emit({"ok": False, "error": "no url given"})
        return 2
    url = sys.argv[1]

    try:
        from spotdl.utils.config import get_config
        from spotdl.utils.spotify import SpotifyClient
    except Exception as exc:  # spotdl not installed
        emit({"ok": False, "error": "spotdl is not installed ({})".format(exc)})
        return 1

    # spotdl's own settings — its credentials, its cache, its retry policy.
    try:
        cfg = get_config()
    except Exception:
        cfg = {}

    init_args = {
        "client_id": cfg.get("client_id"),
        "client_secret": cfg.get("client_secret"),
        "user_auth": cfg.get("user_auth", False),
        "cache_path": cfg.get("cache_path"),
        "no_cache": cfg.get("no_cache", False),
        # no retries: a rate-limited spotipy sleeps for the full
        # Retry-After (24h has been observed), which would hang Crate.
        "max_retries": 0,
    }
    try:
        SpotifyClient.init(**init_args)
    except Exception as exc:
        # already initialised, or an unexpected signature
        if "already" not in str(exc).lower():
            emit({"ok": False, "error": "could not start spotdl's Spotify client: {}".format(exc)})
            return 1

    try:
        if "/album/" in url:
            from spotdl.types.album import Album as Kind
        else:
            from spotdl.types.playlist import Playlist as Kind
        listing = Kind.from_url(url)
    except Exception as exc:
        msg = str(exc)
        if "429" in msg or "rate" in msg.lower():
            emit({"ok": False, "error": "spotdl's Spotify access is rate limited right now", "retry": True})
        else:
            emit({"ok": False, "error": msg[:300]})
        return 1

    tracks = []
    for song in listing.songs:
        tracks.append({
            "id": getattr(song, "song_id", None),
            "name": getattr(song, "name", None),
            "artists": list(getattr(song, "artists", []) or []),
            "artist": getattr(song, "artist", None),
            "album": getattr(song, "album_name", None),
            "album_id": getattr(song, "album_id", None),
            "album_artist": getattr(song, "album_artist", None),
            "duration": getattr(song, "duration", None),
            "year": getattr(song, "year", None),
            "date": getattr(song, "date", None),
            "track_number": getattr(song, "track_number", None),
            "tracks_count": getattr(song, "tracks_count", None),
            "disc_number": getattr(song, "disc_number", None),
            "isrc": getattr(song, "isrc", None),
            "cover_url": getattr(song, "cover_url", None),
            "explicit": getattr(song, "explicit", None),
        })

    emit({
        "ok": True,
        "name": getattr(listing, "name", None) or "Spotify playlist",
        "total": len(tracks),
        "tracks": tracks,
    })
    return 0


if __name__ == "__main__":
    sys.exit(main())
