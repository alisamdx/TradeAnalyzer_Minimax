# Read the latest inflection brief and print the top tradeable pick's short-put-vertical legs.
# Mirrors brief-entry-source: pick the direction-locked vertical, require a valid defined-risk setup.
# Output: one JSON line on stdout with ticker + legs, for the IBKR fill calibration script.
import sqlite3, json, sys

DB = r"C:\Users\shaky\AppData\Roaming\trade-analyzer\trade-analyzer.sqlite"

con = sqlite3.connect(DB)
row = con.execute(
    "SELECT id, generated_at, picks FROM daily_briefs WHERE strategy='inflection' "
    "ORDER BY generated_at DESC LIMIT 1"
).fetchone()
con.close()
if not row:
    print("NO_INFLECTION_BRIEF", file=sys.stderr); sys.exit(1)

brief_id, gen_at, picks_json = row
picks = json.loads(picks_json)
print(f"# brief id={brief_id} generated_at={gen_at} picks={len(picks)}", file=sys.stderr)

SLUG_BY_DIR = {"up": "short-put-vertical", "down": "short-call-vertical"}

def chosen_setup(pick):
    direction = pick.get("breakoutDirection") or "up"
    slug = SLUG_BY_DIR.get(direction, "short-put-vertical")
    scores = ((pick.get("strategyLabResult") or {}).get("scores")) or []
    for s in scores:
        if s.get("slug") != slug:
            continue
        setup = s.get("setup")
        if setup and not setup.get("unavailableReason") and setup.get("maxLoss") is not None:
            return slug, s, setup
    return None, None, None

# Highest composite first; first pick with a constructible vertical wins.
cands = sorted(picks, key=lambda p: p.get("compositeScore", 0), reverse=True)
for pick in cands:
    slug, score, setup = chosen_setup(pick)
    if not setup:
        continue
    legs = [{
        "ticker": pick["ticker"],
        "right": "C" if leg["side"] == "call" else "P",
        "action": leg["action"],
        "strike": leg["strike"],
        "expiry": leg["expiration"][:10],
        "ratio": leg.get("qty", 1),
    } for leg in setup["legs"]]
    out = {
        "ticker": pick["ticker"],
        "structure": slug,
        "breakoutDirection": pick.get("breakoutDirection") or "up",
        "compositeScore": pick.get("compositeScore"),
        "criticVerdict": (pick.get("criticVerdict") or {}).get("verdict"),
        "expiration": setup["expiration"][:10],
        "dte": setup.get("dte"),
        "netCredit_lab": setup.get("netCredit"),
        "maxLoss_lab": setup.get("maxLoss"),
        "liquidityScore": score.get("liquidityScore"),
        "legs": legs,
    }
    print(json.dumps(out))
    sys.exit(0)

print("NO_TRADEABLE_INFLECTION_PICK", file=sys.stderr)
sys.exit(2)
