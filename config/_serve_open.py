import http.server
import socketserver
import threading
import time
import os
import webbrowser

# Gli script sono stati spostati in dashboard/config/: BASE deve puntare
# alla cartella padre (dashboard/), dove stanno frontend/, pubblicabile/, file_standard/.
BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ROOT = os.path.join(BASE, "pubblicabile")
PORT = 8777

os.chdir(ROOT)
Handler = http.server.SimpleHTTPRequestHandler
Handler.log_message = lambda *a, **k: None

httpd = socketserver.TCPServer(("127.0.0.1", PORT), Handler)
threading.Thread(target=httpd.serve_forever, daemon=True).start()

url = "http://127.0.0.1:%d/html/index.html" % PORT
print("Server attivo su:", url)
webbrowser.open(url)

time.sleep(90)
httpd.shutdown()
print("Server arrestato (timeout).")
