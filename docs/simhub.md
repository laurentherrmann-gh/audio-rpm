# Sending the rpm to SimHub

Back to the [README](../README.md).

## SimHub (optional)

UDP output starts paused. Turn it on with **Send to SimHub (UDP)** at the bottom of the page, or
start with it on:

```sh
SIMHUB_UDP=on SIMHUB_HOST=192.168.1.50 npm start     # IP of the Windows PC running SimHub
```

| Variable | Default | |
|---|---|---|
| `SIMHUB_UDP` | off | `on` to start sending immediately |
| `SIMHUB_HOST` | `127.0.0.1` | where SimHub runs |
| `SIMHUB_PORT` | `20777` | SimHub's DiRT Rally 2.0 UDP port |
| `HTTP_PORT` | `8777` | the page |
| `HTTP_HOST` | `127.0.0.1` | the page and its control socket answer on this computer only; `0.0.0.0` opens them to the network |
| `SEND_HZ` | `60` | packets per second to SimHub at least, while the rpm is fresh |
| `MAX_HZ` | `250` | each new rpm is forwarded as it arrives, up to this rate (`60` if SimHub minds) |
| `RPM_DIVISOR` | `10` | DR2 sends rpm / 10; set to `1` if SimHub shows rpm 10× too high |

The rpm (the detector on the tach: **combined** by default), the gear and the idle and redline settings
go from the detection worker straight to the server, and from there to SimHub as each one arrives.
The page's main thread is not in that path (Chrome slows it down when the tab is hidden), and there is
no waiting for a 60 Hz tick (which cost 8 ms on average).

On the Windows PC: select **DiRT Rally 2.0** in SimHub (it may say telemetry is "not configured",
because it can't find the game's config file there; that doesn't matter), allow inbound UDP 20777 in
Windows Firewall, then open any dashboard with a rev counter. The page sends redline and idle too,
so shift lights scale to your settings.

If SimHub shows nothing: run `npm run listen` on that machine with SimHub closed (both can't hold port
20777). If it prints RPM, the bridge works and the problem is on SimHub's side. Untested: if SimHub
insists the game isn't running even though packets arrive, it may be checking for the game's process.
Tools that fake DR2 telemetry for other games have shipped a stand-in `DirtRally2.exe` for this reason.
