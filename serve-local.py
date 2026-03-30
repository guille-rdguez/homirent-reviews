#!/usr/bin/env python3
from __future__ import annotations

import argparse
import functools
from http.server import SimpleHTTPRequestHandler
from pathlib import Path
from socketserver import TCPServer


ROOT = Path(__file__).resolve().parent


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Servidor local para homirent.reviews"
    )
    parser.add_argument(
        "--host",
        default="127.0.0.1",
        help="Host a usar. Ejemplo: 127.0.0.1 o 0.0.0.0",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=4173,
        help="Puerto del servidor local",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    handler = functools.partial(SimpleHTTPRequestHandler, directory=str(ROOT))

    class ReusableTCPServer(TCPServer):
        allow_reuse_address = True

    with ReusableTCPServer((args.host, args.port), handler) as httpd:
        base_url = f"http://{args.host}:{args.port}"
        print("Servidor local listo")
        print(f"Raiz: {ROOT}")
        print(f"Inicio: {base_url}/")
        print(f"Formulario: {base_url}/form.html")
        print(f"Dashboard: {base_url}/dashboard.html")
        print("Presiona Ctrl+C para detenerlo.")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nServidor detenido.")


if __name__ == "__main__":
    main()
