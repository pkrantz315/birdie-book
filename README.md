# Birdie Book

Offline-Notizbuch für Golfplätze: pro Platz, Tee (Schwarz/Weiß/Gelb/Blau/Rot) und Loch
Notizen zum Abschlag, zu den weiteren Schlägen und zum Grün. Alles bleibt lokal im Browser (IndexedDB).

## Dateien
| Datei | Zweck |
|---|---|
| `index.html` | Oberfläche und Styles |
| `app.js` | Logik, Datenbank, Export/Import |
| `sw.js` | Service Worker – App funktioniert offline |
| `manifest.webmanifest`, `*.png` | Name und Icons für den Home-Bildschirm |

## Auf GitHub Pages veröffentlichen
1. Neues Repository anlegen (z. B. `birdie-book`) und alle Dateien hochladen.
2. *Settings → Pages → Branch: main / (root)* → Speichern.
3. Nach ca. 1 Minute läuft die App unter `https://<name>.github.io/birdie-book/`.

## Auf dem iPhone installieren
Seite in **Safari** öffnen → Teilen-Symbol → **Zum Home-Bildschirm**. Danach einmal öffnen –
ab dann läuft sie auch ohne Netz auf dem Platz.

## Lokal testen am Rechner
Im Ordner `python3 -m http.server 8000` starten und `http://localhost:8000` öffnen.
(Direkt per Doppelklick als `file://` geht IndexedDB zwar, der Offline-Modus aber nicht.)

## Backup
- **Backup (JSON)**: vollständige Sicherung, lässt sich 1:1 wieder importieren.
- **Tabelle (CSV)**: eine Zeile pro Loch (Semikolon, für Excel/Numbers), ebenfalls importierbar.
  Spalten: `Platz;Tee;Loch;Par;Laenge_m;Abschlag;Schlag_2;Schlag_3;Gruen`

Auf dem iPhone öffnet der Export das Teilen-Menü → „In Dateien sichern“.

## Updates ausrollen
Geänderte Dateien hochladen und in `sw.js` die Versionsnummer in `CACHE` erhöhen
(z. B. `birdie-book-v2`). Die App lädt die neue Version beim nächsten Start nach.
