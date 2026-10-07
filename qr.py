import qrcode

for i in range(1, 16):
    data = f"https://balaisilayan.com/table/{i}"
    img = qrcode.make(data)
    img.save(f"table_{i:02d}.png")

print("All 15 QR codes generated successfully!")