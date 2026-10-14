SkyDeck - a browser control centre for Microsoft Flight Simulator 2020
=======================================================================

What it does
------------
SkyDeck shows your aircraft, a moving map and your flight plan in a web browser,
ideally on a second monitor, and lets you control the aircraft from there:
autopilot, radios, transponder, lights, flaps, fuel, time of day, pause and
sim rate, moving the aircraft, and building and loading flight plans with
SIDs, STARs and approaches. It also has text ATC that takes you from clearance
delivery to your parking stand, with taxi routes on the real airport layout.

Getting started
---------------
1. Unzip this folder anywhere (for example Documents\SkyDeck). Keep all files together.
2. Double-click SkyDeck.exe.
   - Windows may say "Windows protected your PC" because SkyDeck is not signed.
     Click "More info", then "Run anyway".
   - A black window opens. Keep it open while you fly; closing it stops SkyDeck.
3. Your browser opens SkyDeck. The first time, it asks where Microsoft Flight
   Simulator is installed. It usually finds it by itself, so just press Continue.
4. Start MSFS and load a flight. SkyDeck connects by itself.

If the browser does not open, go to http://localhost:4500 yourself.
No MSFS handy? Press "Try the demo aircraft" to explore with a simulated plane.

Tips
----
- Drag panel tabs to arrange the screen. The expand button at the top right of
  a panel opens a larger view with more detail.
- Press Ctrl+K and type commands: alt 8000, hdg 270, com1 121.5, squawk 7000,
  direct LGAV, final LGIR 27, route LGIR SIT LGAV, pause, rate 4, time 18:30.
- Right-click the map to fly direct to a point, add it to the route, or move
  the aircraft there. Click an airport for frequencies and runways.
- Flight plan: pick runways, SIDs, STARs and approaches in the large view, then
  press "Send to aircraft". See "Flight plans and glass cockpits" below.

ATC and taxiing
---------------
Pick the "Airport" layout (top bar) to see the ATC and Ground panels.
- ATC: press Start ATC. SkyDeck uses your flight plan's departure and
  destination; without a plan it sets up a local VFR flight. Tune the
  frequency shown (the Tune button does it for you), then press the
  highlighted button to call: clearance, taxi, ready for departure, check in
  and so on. Controllers answer in the log and hand you on to the next one:
  Delivery, Ground, Tower, Departure, Control, Approach, Tower, Ground.
- Read back clearances with the Read back button. SkyDeck warns you about
  taxiing or taking off without clearance, entering a runway, leaving the taxi
  route, the wrong altitude and the wrong squawk.
- Ground: the taxi route is drawn on the map in magenta, with the next turn and
  the distance to go. Zoom the map in on any airport to see its taxiways,
  hold-short points (red) and stands. Click a stand to taxi there, move the
  aircraft onto it, or choose it as your stand at the destination. Near the
  stand, a docking board shows how far to go and which way to steer.
- Turn off the simulator's own ATC voice. If MSFS's ATC keeps COM 1 on its own
  frequency (its auto-tune assistance does that), SkyDeck tunes COM 2 instead.

Flight plans and glass cockpits (SkyDeck Link)
----------------------------------------------
Aircraft with modern avionics (G1000 NXi, G3000, airliners) keep their own flight
plan and only read the one from MSFS when a flight starts. So:

- Before the flight: build the plan in SkyDeck while MSFS is on the World Map
  or main menu, press "Send to aircraft", then start the flight.
- During the flight, in G1000 NXi aircraft (for example the Cessna 172 G1000
  and the 208 Grand Caravan): install SkyDeck Link once from Settings > SkyDeck Link,
  then restart MSFS. "Send to aircraft" and "Direct to" then change the NXi's
  own flight plan, with real SIDs, STARs and approaches. The flight plan panel
  shows what the avionics currently hold.

SkyDeck Link is a small "skydeck-link" folder in your MSFS Community folder. It
adds one line to a copy of the NXi's MFD page and changes nothing else.
Settings > SkyDeck Link > Remove deletes it again (restart MSFS afterwards).

Using a tablet or laptop as well
--------------------------------
Settings > "Let other devices on my network open SkyDeck". SkyDeck then shows
the address to open on the other device (for example http://192.168.1.20:4500).
Windows may ask whether to allow network access: allow it on private networks.

Where things are stored
-----------------------
Settings, layouts and your flight plan: %APPDATA%\SkyDeck
SkyDeck never changes files in your MSFS folder; it only reads the World Map
flight plan from it.

Credits
-------
Airport and navaid data: OurAirports (public domain).
Map tiles: Esri, HERE, Garmin, OpenStreetMap contributors.
Fonts: B612 (Airbus, SIL Open Font License), Barlow Semi Condensed (SIL OFL).

License
-------
SkyDeck is free for noncommercial use under the PolyForm Noncommercial
License 1.0.0 (see LICENSE.md). You may share and change it, but not sell it.
