# improve/25 — toss-up finger depth treated as hidden (user idea 23:41)

User: when a finger's direction can't be seen, stay with the object / estimated pose instead of moving much.
Already tried and failed (improve/12): plain hold (keep answer unless 20% better), motion-limited bends, LEAN_KEEP exists.
New here: lift.js marks a finger a toss-up when another lean within AMB cost draws a clearly different finger (bends differ > 30 deg);
its far joints (PIP/DIP, thumb MCP/IP) count as hidden, so the grip prior (object + seen fingers, planned over the take) decides them.
Prediction (before measuring): five cases snap 36 -> 28 or lower, tpierce 28 no worse; real held-out jump 200 / fjump 33 no worse (5%); dev regress all pass.
Result (five cases, base snap 36 / tpierce 28 / opened 395):
AMB 2: snap 35, tpierce 25, opened 395. AMB 4: snap 35, tpierce 23. AMB 8: snap 27, tpierce 31, opened 459 (thumb_track 86 -> 146).
Prediction (snap <= 28 with tpierce no worse) not met at any margin -> reverted before held-out/dev runs. Time 5-7 -> 10-15 ms/frame (grip prior runs more).
