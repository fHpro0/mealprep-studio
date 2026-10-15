"""mealprep — command line.

    mealprep init  <dir> [--lang de|en]   create a household folder from the example
    mealprep serve <dir> [--port N]       start the web app (LAN)
    mealprep run   <dir> <action> [id]    run an action without the web app
                                          actions: neue_runde | ueberarbeiten | plan_erstellen | feedback_uebernehmen
    mealprep calc  <dir> <round-id>       recalculate macros/costs of a round (after hand edits)
    mealprep check <dir>                  validate config, ingredient DB, claude CLI, offers
"""
from __future__ import annotations

import shutil
import socket
import subprocess
import sys
from pathlib import Path

from . import actions, calc, config, prices


def _ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("10.255.255.255", 1))
        return s.getsockname()[0]
    except OSError:
        return ""


def cmd_init(args):
    target = Path(args[0]).expanduser()
    lang = args[args.index("--lang") + 1] if "--lang" in args else "en"
    src = config.REPO / "examples" / f"household-{lang}"
    if (target / "household.toml").exists():
        sys.exit(f"{target}/household.toml already exists — nothing overwritten.")
    target.mkdir(parents=True, exist_ok=True)
    for f in src.iterdir():
        if not (target / f.name).exists():
            shutil.copy2(f, target / f.name)
    print(f"Created {target}. Edit household.toml and profile.md, then:  mealprep serve {target}")


def cmd_serve(args):
    from .server import serve
    hh = config.load(args[0])
    port = int(args[args.index("--port") + 1]) if "--port" in args else None
    httpd, port = serve(hh, port)
    print(f"{hh.name}\n  this computer:  http://localhost:{port}")
    if ip := _ip():
        print(f"  phone / LAN:    http://{ip}:{port}")
    if not hh.server["pin"]:
        print("  note: no PIN set — anyone on your network can trigger the planner ([server] pin = \"…\")")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


def cmd_run(args):
    hh = config.load(args[0])
    action, ident = args[1], (args[2] if len(args) > 2 else "")
    print(actions.ACTIONS[action](hh, ident, lambda phase: print(f"… {phase}", flush=True)))
    for t in actions.BACKGROUND:
        t.join()


def cmd_calc(args):
    hh = config.load(args[0])
    db = calc.load_ingredients(hh)
    path = hh.paths["rounds"] / f"{args[1]}.json"
    r = actions.read(path)
    for c in r["kandidaten"]:
        calc.calculate(hh, db, c)
        m = c["makros"]
        print(f"{c['id']:<22} " + " | ".join(f"{p} {m[p]['kcal']} kcal {m[p]['p']} g P" for p in m)
              + f" | {c['kosten']:.2f} | x{c['berechnet']['skalierung']}")
    pr = prices.compare(hh, db, r, r.get("einkauf_iso") or "")
    if pr:
        actions.write(path.with_name(path.stem + "-preise.json"), pr)
    actions.write(path, r)


def cmd_check(args):
    hh = config.load(args[0])
    db = calc.load_ingredients(hh)
    ok = True
    print(f"household: {hh.name} · {len(hh.persons)} persons · meals {[m['id'] for m in hh.meals]} · {hh.days} days")
    for m in hh.meals:
        print(f"  {m['id']}: " + ", ".join(f"{p['id']} {round(hh.meal_target(m['id'], p['id']))} kcal" for p in hh.persons))
    bad = [k for k, v in db.items() if not all(x in v for x in ("name", "kcal", "p", "kh", "eur_kg", "pack_g"))]
    print(f"ingredients: {len(db)} ({'ok' if not bad else 'incomplete: ' + ', '.join(bad)})")
    ok &= not bad
    cli = shutil.which(hh.agent["command"]) or str(Path.home() / ".local/bin" / hh.agent["command"])
    try:
        v = subprocess.run([cli, "--version"], capture_output=True, text=True, timeout=20).stdout.strip()
        print(f"claude cli: {v}")
    except (OSError, subprocess.TimeoutExpired):
        print("claude cli: NOT FOUND — install Claude Code (https://claude.com/claude-code) and log in")
        ok = False
    if hh.offers["enabled"]:
        try:
            from . import offers
            offers.get_keys()
            print(f"offers: marktguru reachable, zip {hh.offers['zip']}, retailers {hh.offers['retailers'] or 'all'}")
        except Exception as e:  # noqa: BLE001
            print(f"offers: not available ({e}) — planning still works with estimated prices")
    else:
        print("offers: disabled")
    sys.exit(0 if ok else 1)


def main():
    a = sys.argv[1:]
    cmds = {"init": cmd_init, "serve": cmd_serve, "run": cmd_run, "calc": cmd_calc, "check": cmd_check}
    if not a or a[0] not in cmds or len(a) < 2:
        sys.exit(__doc__)
    cmds[a[0]](a[1:])


if __name__ == "__main__":
    main()
