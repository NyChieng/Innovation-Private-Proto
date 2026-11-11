"""Hand-centred crops for the touch classifier. Shared by training (scripts/make_touch_crops.py)
and the live pipeline so both cut exactly the same region.

The crop sits on the hand (the wrist pushed a little further along the forearm) and is sized by
forearm length, so a hand on a big shrub and a hand on a small seedling look alike to the model.
"""
import cv2
import numpy as np

CROP_PX = 224


def hand_box(wrist, elbow, person_h):
    """wrist, elbow: (x, y) or None for elbow. Returns a square (x0, y0, x1, y1) around the hand."""
    wrist = np.asarray(wrist, float)
    if elbow is not None:
        elbow = np.asarray(elbow, float)
        fore = np.linalg.norm(wrist - elbow)
        centre = wrist + 0.35 * (wrist - elbow)
    else:
        fore, centre = 0.0, wrist
    r = max(0.9 * fore, 0.08 * person_h, 24.0)
    return centre[0] - r, centre[1] - r, centre[0] + r, centre[1] + r


def cut(img, box, size=CROP_PX):
    """Crop box out of img (padding with grey past the edges) and resize to size x size."""
    h, w = img.shape[:2]
    x0, y0, x1, y1 = (int(round(v)) for v in box)
    pad = max(0, -x0, -y0, x1 - w, y1 - h)
    if pad:
        img = cv2.copyMakeBorder(img, pad, pad, pad, pad, cv2.BORDER_CONSTANT, value=(114, 114, 114))
        x0, y0, x1, y1 = x0 + pad, y0 + pad, x1 + pad, y1 + pad
    crop = img[y0:y1, x0:x1]
    if crop.size == 0:
        return None
    return cv2.resize(crop, (size, size), interpolation=cv2.INTER_AREA)


def box_dist(pt, box):
    """Distance from a point to a box (0 when inside)."""
    dx = max(box[0] - pt[0], 0, pt[0] - box[2])
    dy = max(box[1] - pt[1], 0, pt[1] - box[3])
    return float(np.hypot(dx, dy))
