# iot-node (old Wokwi simulation)

No longer used. This is the PlatformIO/Wokwi simulation of the sensor node. The
team now runs `iot-kit/FloraScan_Node/FloraScan_Node.ino` on the real ESP32 kit
instead. This folder is kept for reference and is not maintained.

It still works with the backend if you run it: the server ignores its
`light_lux` field, since the database has no light column any more, and it sends
no distance reading.
