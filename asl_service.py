from __future__ import annotations

import base64
import io
import os
from functools import lru_cache
from pathlib import Path

import torch
import torch.nn as nn
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from huggingface_hub import hf_hub_download
from PIL import Image, ImageOps
from pydantic import BaseModel
from torchvision import models, transforms


MODEL_REPO = "huzaifanasirrr/realtime-sign-language-translator"
IMAGE_SIZE = 224
_MODEL_DIR_ENV = os.getenv("MODEL_DIR", "").strip()
MODEL_DIR = Path(_MODEL_DIR_ENV).expanduser() if _MODEL_DIR_ENV else None
ALLOW_HF_DOWNLOAD = os.getenv("ALLOW_HF_DOWNLOAD", "1").strip().lower() not in {"0", "false", "no"}


class SignLanguageModel(nn.Module):
    def __init__(self, num_classes: int = 26, pretrained: bool = False):
        super().__init__()
        self.model = models.resnet18(weights=None if not pretrained else models.ResNet18_Weights.DEFAULT)
        self.model.fc = nn.Sequential(
            nn.Dropout(0.5),
            nn.Linear(512, 512),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(512, num_classes),
        )

    def forward(self, x):
        return self.model(x)


class PredictRequest(BaseModel):
    image: str


def _load_image_from_data_url(data_url: str) -> Image.Image:
    if "," in data_url:
        data_url = data_url.split(",", 1)[1]
    raw = base64.b64decode(data_url)
    img = Image.open(io.BytesIO(raw))
    img = ImageOps.exif_transpose(img)
    return img.convert("RGB")


def _build_transform():
    return transforms.Compose(
        [
            transforms.Resize((IMAGE_SIZE, IMAGE_SIZE)),
            transforms.ToTensor(),
            transforms.Normalize(
                mean=[0.485, 0.456, 0.406],
                std=[0.229, 0.224, 0.225],
            ),
        ]
    )


@lru_cache(maxsize=1)
def load_model_bundle():
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

    if MODEL_DIR is not None and MODEL_DIR.exists():
        model_path = MODEL_DIR / "best_model.pth"
        mapping_path = MODEL_DIR / "class_mapping.json"
        if not model_path.exists() or not mapping_path.exists():
            raise FileNotFoundError(
                f"MODEL_DIR={MODEL_DIR} is missing best_model.pth or class_mapping.json"
            )
    elif ALLOW_HF_DOWNLOAD:
        model_path = Path(hf_hub_download(repo_id=MODEL_REPO, filename="best_model.pth"))
        mapping_path = Path(hf_hub_download(repo_id=MODEL_REPO, filename="class_mapping.json"))
    else:
        raise FileNotFoundError(
            "No local model files found and ALLOW_HF_DOWNLOAD is disabled."
        )

    checkpoint = torch.load(model_path, map_location=device)
    model = SignLanguageModel(num_classes=26, pretrained=False)
    state_dict = checkpoint.get("model_state_dict", checkpoint)
    model.load_state_dict(state_dict)
    model.to(device)
    model.eval()

    import json

    with open(mapping_path, "r", encoding="utf-8") as fh:
        mapping = json.load(fh)

    idx_to_class = mapping.get("idx_to_class", {})
    transform = _build_transform()

    return {
        "device": device,
        "model": model,
        "idx_to_class": idx_to_class,
        "transform": transform,
        "val_acc": checkpoint.get("val_acc"),
        "model_path": str(model_path),
        "mapping_path": str(mapping_path),
    }


app = FastAPI(title="ASL Inference Service")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health():
    bundle = load_model_bundle()
    return {
        "ok": True,
        "device": str(bundle["device"]),
        "classes": len(bundle["idx_to_class"]),
        "val_acc": bundle["val_acc"],
        "model_path": bundle["model_path"],
    }


@app.post("/predict")
def predict(request: PredictRequest):
    try:
        bundle = load_model_bundle()
        image = _load_image_from_data_url(request.image)
        tensor = bundle["transform"](image).unsqueeze(0).to(bundle["device"])

        with torch.no_grad():
            logits = bundle["model"](tensor)
            probs = torch.softmax(logits, dim=1)[0]

        top_probs, top_idxs = torch.topk(probs, k=3)
        top3 = []
        for prob, idx in zip(top_probs.tolist(), top_idxs.tolist()):
            label = bundle["idx_to_class"].get(str(idx), str(idx))
            top3.append({"label": label, "confidence": float(prob)})

        best = top3[0]
        return {
            "label": best["label"],
            "confidence": best["confidence"],
            "top3": top3,
        }
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8765)
