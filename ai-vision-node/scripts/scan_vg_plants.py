"""Pull every person/hand -> plant relationship out of Visual Genome's relationships.json.

The 744 MB file is one JSON list; parsing it whole needs ~6 GB of RAM, so it is split on image
boundaries and only images that mention a plant synset are parsed.

    python scripts/scan_vg_plants.py
-> data/raw/vg/plant_rels.json  [{image_id, predicate, subj, subj_box, obj, obj_box}], boxes xyxy
"""
import json
import re
from collections import Counter

from fg_common import RAW

VG = RAW / "vg"
HUMAN = {"man.n.01", "woman.n.01", "person.n.01", "boy.n.01", "girl.n.01", "child.n.01", "kid.n.01",
         "lady.n.01", "guy.n.01", "people.n.01", "hand.n.01", "finger.n.01", "arm.n.01", "player.n.01",
         "skier.n.01", "worker.n.01", "farmer.n.01", "gardener.n.01", "adult.n.01", "male_child.n.01",
         "female_child.n.01", "mother.n.01", "father.n.01", "tourist.n.01", "palm.n.03"}
PLANT = {"plant.n.02", "flower.n.01", "bush.n.01", "shrub.n.01", "tree.n.01", "leaf.n.01", "branch.n.02",
         "houseplant.n.01", "vine.n.01", "fern.n.01", "pot_plant.n.01", "bouquet.n.01", "rose.n.01",
         "sunflower.n.01", "daisy.n.01", "tulip.n.01", "foliage.n.01", "hedge.n.01", "palm.n.03",
         "stem.n.01", "twig.n.01", "petal.n.01", "cactus.n.01", "bamboo.n.01", "orchid.n.01"}
# many objects carry no synset, so names count too
HUMAN_WORDS = re.compile(r"^(?:man|woman|person|boy|girl|child|kid|lady|guy|people|hand|hands|finger|fingers|arm|"
                         r"player|worker|farmer|gardener|men|women|she|he|lady's hand|man's hand|woman's hand)$")
PLANT_WORDS = re.compile(r"(?:plants?|flowers?|bush(?:es)?|shrubs?|trees?|leaf|leaves|branch(?:es)?|houseplant|"
                         r"vines?|ferns?|bouquet|roses?|sunflowers?|tulips?|daisy|daisies|foliage|hedges?|palms?|"
                         r"cactus|bamboo|orchids?|petals?|twigs?|stems?|greenery|seedlings?|sapling)")
HINT = re.compile(r'"(?:' + "|".join(re.escape(s) for s in PLANT) + r')"|' + PLANT_WORDS.pattern)


def is_human(o):
    return bool(set(o.get("synsets", [])) & HUMAN) or bool(HUMAN_WORDS.match(name(o).lower().strip()))


def is_plant(o):
    if "trunk" in name(o).lower():  # VG tags elephant trunks with the tree-trunk synset
        return False
    return bool(set(o.get("synsets", [])) & PLANT) or bool(PLANT_WORDS.search(name(o).lower()))


def name(o):
    return o.get("name") or (o.get("names") or [""])[0]


def box(o):
    return [o["x"], o["y"], o["x"] + o["w"], o["y"] + o["h"]]


def main():
    text = (VG / "relationships.json").read_text(encoding="utf-8")
    starts = [m.start() for m in re.finditer(r'\{"relationships": ', text)]
    print(f"{len(starts)} images")
    out, preds = [], Counter()
    for i, s in enumerate(starts):
        e = starts[i + 1] if i + 1 < len(starts) else len(text)
        chunk = text[s:e]
        if not HINT.search(chunk):
            continue
        img = json.loads(chunk.rstrip().rstrip("]").rstrip().rstrip(","))
        for r in img["relationships"]:
            su, ob = r["subject"], r["object"]
            if not is_human(su) or not is_plant(ob):
                continue
            p = r["predicate"].lower().strip()
            preds[p] += 1
            out.append({"image_id": img["image_id"], "predicate": p,
                        "subj": name(su), "subj_box": box(su), "obj": name(ob), "obj_box": box(ob)})
    (VG / "plant_rels.json").write_text(json.dumps(out))
    print(f"{len(out)} person->plant relationships in {len({o['image_id'] for o in out})} images")
    for p, n in preds.most_common(60):
        print(f"{n:6}  {p}")


if __name__ == "__main__":
    main()
