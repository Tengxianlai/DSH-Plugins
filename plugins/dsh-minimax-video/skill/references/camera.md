# Camera language for H3

H3 follows camera direction best when the move is written as natural prose with a **type, direction, amplitude, speed and target**, and when the move is motivated by something in the shot. A list of tags ("pan, zoom, dolly, cinematic") is weaker than one clear sentence.

## Shot size and angle

| Term | Chinese | Use |
|---|---|---|
| extreme wide shot / establishing shot | 大远景 / 建立镜头 | place, scale, isolation |
| wide shot | 远景 | full body, environment |
| medium-wide shot | 中远景 | body plus context |
| medium shot | 中景 | gesture, two-shot |
| medium close-up | 中近景 | face plus shoulders |
| close-up | 近景 | emotion, detail |
| extreme close-up | 特写 | eye, mouth, object texture |
| macro | 微距 | texture only; avoid hands |
| low angle | 仰拍 | power, threat |
| high angle | 俯拍 | vulnerability, geometry |
| overhead / top shot | 顶拍 | pattern, tableau |
| Dutch angle | 荷兰角 | unease; use sparingly |
| over-the-shoulder | 过肩 | conversation, POV anchor |
| POV | 主观视角 | immersion |

Name the angle only when it changes the meaning. "Eye level" is a useful default and can be stated once.

## Movement vocabulary

| Term | Chinese | What moves | Effect | Watch out |
|---|---|---|---|---|
| static shot | 固定镜头 | nothing | control, observation | say it explicitly if drift would hurt |
| push in | 推镜 | camera body forward | intimacy, realization | not the same as zoom |
| pull out | 拉镜 | camera body backward | reveal, isolation | needs space behind the subject |
| zoom in / zoom out | 变焦 | focal length only | compression, snap | camera body stays still |
| pan left / right | 摇镜 | lens pivots horizontally | scan, follow | too fast reads as a whip |
| tilt up / down | 俯仰 | lens pivots vertically | reveal height | pair with a subject at the end |
| truck left / right | 横移 | camera body sideways | parallax, travel | keep subject in a third |
| pedestal up / down | 升降 | camera body vertically | status change | not a crane arc |
| arc shot | 环绕 | camera orbits subject | romance, menace | 4 s cannot do a full 360° |
| tracking shot | 跟随 | camera follows subject | momentum | state whether it leads or trails |
| handheld | 手持 | operator-held instability | immediacy, documentary | do not combine with "static" |
| roll clockwise / counterclockwise | 旋转 | lens axis rotates | disorientation | use once, briefly |
| rack focus | 移焦 | focus plane moves | attention shift | name the start and end point |

## Writing the move

Good:

```text
The camera pushes in with small amplitude at slow speed, from a medium-wide shot to a medium close-up, settling on her eyes as the name is spoken.
```

```text
The camera tracks behind him at a fast walking pace, handheld, staying half a metre above his shoulder.
```

Weak:

```text
cinematic camera movement, dynamic angle, pan zoom dolly
```

Why: no subject, no direction, no endpoint, and several incompatible moves at once.

## Amplitude and speed

Add them only when they carry meaning:

- `with small amplitude at slow speed` — a subtle push, a slow creep.
- `with large amplitude at fast speed` — a whip, a rush, a shock.
- Omit both for an ordinary move; "the camera pans left" is enough.

Amplitude and speed are not decoration. A "slight push in" repeated across chained clips compounds into a visible zoom, so for continuity shots say "that exact shot size and camera position hold from the first frame to the last".

## Time and cutting

- A camera move needs time to read. Under 2 s, prefer a cut or a static shot.
- In a 4–5 s clip: one move, or one move plus a cut. In 10 s: two or three shots. In 15 s: at most about three cuts, or one long developing move.
- A cut must add information, viewpoint, space, state or time. If it only reframes, move the camera.
- Cut times use `[Shot N] At MM:SS.mmm, the camera cuts to ...` and must strictly increase.
- Transitions other than a cut (dissolve, wipe, match cut) can be described, but they are less reliable than a hard cut. A match cut works best when the outgoing and incoming compositions share a shape.

## Focus and lens

- `shallow depth of field`, `deep focus`, `rack focus from the foreground glass to the hand behind it` are useful and concrete.
- Focal length language ("wide 24 mm", "long 85 mm") is understood loosely. Prefer the visible consequence: "wide lens, the room stretching at the edges" or "long lens, the background compressed".
- Do not ask for a lens brand or a specific camera body; it adds no reliable control.

## Common failures

| Failure | Fix |
|---|---|
| "zoom" used for a physical push | choose `push in` vs `zoom in` deliberately |
| two moves in one shot ("pan and push and orbit") | one primary move; cut for the second |
| full 360° arc in 4 s | use a 90° arc or a cut |
| camera moves with no subject | end the move on a person, object or reveal |
| "handheld static" | pick one; handheld implies instability |
| no shot size at the start | establish wide/medium/close in Shot 1 |
| camera crosses the eyeline between shots | keep screen direction; state who looks where |
| move described only as a tag | write type + direction + amplitude + speed + target |

## Continuity across clips

For a multi-clip sequence:

- Carry the last frame of clip A into clip B as `first_frame`; describe the new action from that pose.
- Keep the style sentence and the light direction identical.
- Keep the same shot size if the cut is meant to be invisible; change it if the cut is meant to be felt.
- A reference picture's orientation sets the direction of travel: a train pictured from the front arrives however the prompt says "pulls away". Choose the reference angle that matches the intended movement.
