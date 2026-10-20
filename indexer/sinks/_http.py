"""Shared HTTP plumbing for sinks (stdlib only). The leading underscore keeps this module out of the sink registry.

`open_url` is the one place a sink opens a URL. It differs from `urllib.request.urlopen` in two ways that every
REST sink wants:

- It follows no redirect at all. A 3xx reply surfaces as `urllib.error.HTTPError` (carrying the status), so a sink
  never silently re-issues a write as a GET, and an API key in the request can never be handed to another host.
- `http.client.HTTPException` (BadStatusLine, IncompleteRead, LineTooLong, ...) becomes `OSError`. A server that
  speaks garbage is then "unreachable", which is the failure the sink contract already allows (`SinkError` or
  `OSError`), and `health()` can catch `OSError` alone.
"""

import http.client
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """Refuse every redirect: `redirect_request` returns None, so urllib raises the 3xx as an HTTPError."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


OPENER = urllib.request.build_opener(NoRedirect)


def open_url(request: urllib.request.Request, timeout: float):
    """Open `request` without following redirects. Returns the response (a context manager).

    Raises `urllib.error.HTTPError` for any non-2xx status (3xx included), `urllib.error.URLError` or another
    `OSError` when the server cannot be reached, and `OSError` for a malformed HTTP reply.
    """
    try:
        return OPENER.open(request, timeout=timeout)
    except http.client.HTTPException as error:
        raise OSError(f"{type(error).__name__}: {error}") from error


def read_all(response) -> bytes:
    """`response.read()` for a response or an HTTPError, with `http.client.HTTPException` turned into `OSError`."""
    try:
        return response.read()
    except http.client.HTTPException as error:
        raise OSError(f"{type(error).__name__}: {error}") from error
