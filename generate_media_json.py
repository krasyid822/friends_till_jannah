import os
import json

# Folder media
folder = os.path.dirname(__file__)

# Ekstensi media yang didukung
media_exts = {'.jpg', '.jpeg', '.png', '.webp', '.mp4', '.webm', '.mov'}

files = [f for f in os.listdir(folder) if os.path.splitext(f)[1].lower() in media_exts]
files.sort()

media_json_path = os.path.join(folder, 'media.json')

if not files:
    print('Tidak ada file media di folder ini, media.json tidak diubah.')
    raise SystemExit(0)

with open(media_json_path, 'w', encoding='utf-8') as fp:
    json.dump(files, fp, ensure_ascii=False, indent=2)

print(f"{len(files)} media files written to media.json")
