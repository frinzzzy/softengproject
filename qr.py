import qrcode

for i in range(1, 16):
    # Gamitin ang iyong live Render domain at ang eksaktong token sa database (lmco-table-i)
    data = f"https://softengproject.onrender.com/api/session/scan/lmco-table-{i}"
    
    img = qrcode.make(data)
    img.save(f"table_{i:02d}.png")

print("All 15 QR codes generated successfully with correct backend scan links!")