# Blinking red tally button (CamStreamer stream)

The plugin now publishes a **TALLY** state per stream that does the blinking for you.
You don't need timers or loops in Touch Portal — just react to the state value.

## The tally state

For each discovered stream the plugin creates:

- `Axis: Stream "<name>" TALLY (blink)` — value cycles automatically:
  - `blink` and `dark` alternate every ~0.6 s **while the stream is live**
  - `idle` when the stream is off

(There is also `Axis: Stream "<name>" on/off` if you only want a steady on/off look.)

## Build the button

1. **On Pressed**
   - Action: *CamStreamer stream* → pick your stream → mode **Toggle**.

2. **On Event** → add **three** "When plug-in state changes" events on the
   TALLY state (`Axis: Stream "<name>" TALLY (blink)`):

   | State value | Change visuals to        | Text  |
   |-------------|--------------------------|-------|
   | `blink`     | bright red background     | LIVE  |
   | `dark`      | dark red / near-black     | LIVE  |
   | `idle`      | gray background           | OFF   |

   Use *Change visuals of this button* (background color + button text) inside each event.

The `blink` ↔ `dark` alternation makes the button flash red while live; `idle`
holds a steady gray when the stream is off. Because it's driven by the camera's
real state (polled), it flashes even if the stream is started/stopped elsewhere.

## Tip: use background images instead of colors

For a nicer look, make two PNGs (bright red tally, dark tally) and set them as
the button background in the `blink` / `dark` events instead of solid colors.

## Note on a "starter page"

Touch Portal plugins can only define actions, states and events — they cannot
create pages or buttons automatically. The fastest path to a ready-made layout
is to build one page once, then export it (Touch Portal → page menu → Export)
and re-import on other setups.
