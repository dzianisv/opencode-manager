#!/usr/bin/env python3
"""
Coqui TTS Server with Dynamic Model Support
Runs as a subprocess managed by the OpenCode Manager backend.
Provides HTTP API for text-to-speech synthesis using Coqui TTS with multiple voice models.
"""

import os
import sys
import io
import logging
from pathlib import Path
from typing import Optional, List, Dict, Any

try:
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel
    import uvicorn
except ImportError:
    print("Installing required packages...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "fastapi", "uvicorn", "pydantic"])
    from fastapi import FastAPI, HTTPException
    from fastapi.responses import StreamingResponse
    from pydantic import BaseModel
    import uvicorn

try:
    import torch
except ImportError:
    print("Installing torch...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "torch"])
    import torch

try:
    from TTS.api import TTS
    from TTS.utils.manage import ModelManager
except ImportError:
    print("Installing TTS...")
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "TTS"])
    from TTS.api import TTS
    from TTS.utils.manage import ModelManager

import scipy.io.wavfile as wavfile
import numpy as np

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="Coqui TTS Server", version="2.0.0")

COQUI_PORT = int(os.environ.get("COQUI_PORT", "5554"))
COQUI_HOST = os.environ.get("COQUI_HOST", "127.0.0.1")
COQUI_DEVICE = os.environ.get("COQUI_DEVICE", "auto")
COQUI_MODEL = os.environ.get("COQUI_MODEL", "tts_models/en/jenny/jenny")

# Global state
model: Optional[TTS] = None
current_model_name: str = COQUI_MODEL
device: str = "cpu"
sample_rate: int = 22050
available_models_cache: List[Dict[str, Any]] = []

# Curated list of high-quality TTS models
RECOMMENDED_MODELS = [
    {
        "id": "tts_models/en/vctk/vits",
        "name": "VCTK VITS",
        "description": "VCTK VITS (109 speakers, recommended)",
        "language": "en",
        "quality": "high",
        "speed": "fast",
        "multi_speaker": True,
        "recommended": True
    },
    {
        "id": "tts_models/en/ljspeech/vits",
        "name": "LJSpeech VITS",
        "description": "LJSpeech single speaker",
        "language": "en",
        "quality": "high",
        "speed": "fast",
        "multi_speaker": False
    },
    {
        "id": "tts_models/en/jenny/jenny",
        "name": "Jenny",
        "description": "Jenny voice",
        "language": "en",
        "quality": "high",
        "speed": "medium",
        "multi_speaker": False
    },
    {
        "id": "tts_models/multilingual/multi-dataset/xtts_v2",
        "name": "XTTS v2",
        "description": "XTTS v2 with voice cloning",
        "language": "multilingual",
        "quality": "very_high",
        "speed": "slow",
        "multi_speaker": True,
        "voice_cloning": True
    },
    {
        "id": "tts_models/multilingual/multi-dataset/bark",
        "name": "Bark",
        "description": "Multilingual neural TTS",
        "language": "multilingual",
        "quality": "high",
        "speed": "slow",
        "multi_speaker": False
    }
]

# Detailed metadata for popular VCTK speakers
VCTK_METADATA = {
    "p226": {"gender": "Male", "accent": "English", "desc": "Clear, professional (recommended)"},
    "p225": {"gender": "Female", "accent": "English", "desc": "Clear, neutral"},
    "p227": {"gender": "Male", "accent": "English", "desc": "Deep voice"},
    "p228": {"gender": "Female", "accent": "English", "desc": "Warm tone"},
    "p229": {"gender": "Female", "accent": "English", "desc": "Higher pitch"},
    "p230": {"gender": "Female", "accent": "English", "desc": "Soft voice"},
    "p231": {"gender": "Male", "accent": "English", "desc": "Standard"},
    "p232": {"gender": "Male", "accent": "English", "desc": "Casual"},
    "p233": {"gender": "Female", "accent": "Scottish", "desc": "Scottish accent"},
    "p234": {"gender": "Female", "accent": "Scottish", "desc": "Scottish accent"},
    "p236": {"gender": "Female", "accent": "English", "desc": "Professional"},
    "p237": {"gender": "Male", "accent": "Scottish", "desc": "Scottish accent"},
    "p238": {"gender": "Female", "accent": "N. Irish", "desc": "Northern Irish"},
    "p239": {"gender": "Female", "accent": "English", "desc": "Young voice"},
    "p240": {"gender": "Female", "accent": "English", "desc": "Mature voice"},
    "p241": {"gender": "Male", "accent": "Scottish", "desc": "Scottish accent"},
    "p243": {"gender": "Male", "accent": "English", "desc": "Deep, authoritative"},
    "p244": {"gender": "Female", "accent": "English", "desc": "Bright voice"},
    "p245": {"gender": "Male", "accent": "Irish", "desc": "Irish accent"},
    "p246": {"gender": "Male", "accent": "Scottish", "desc": "Scottish accent"},
    "p247": {"gender": "Male", "accent": "Scottish", "desc": "Scottish accent"},
    "p248": {"gender": "Female", "accent": "Indian", "desc": "Indian English"},
    "p249": {"gender": "Female", "accent": "Scottish", "desc": "Scottish accent"},
    "p250": {"gender": "Female", "accent": "English", "desc": "Standard"},
    "p251": {"gender": "Male", "accent": "Indian", "desc": "Indian English"},
}


class SynthesizeRequest(BaseModel):
    text: str = None
    input: str = None  # OpenAI-compatible alias
    voice: str = "default"
    speed: float = 1.0


class ChangeModelRequest(BaseModel):
    model_id: str


def get_device() -> str:
    global device
    if COQUI_DEVICE == "auto":
        if torch.cuda.is_available():
            device = "cuda"
        elif hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
            device = "cpu"  # MPS has issues with some TTS models, use CPU
        else:
            device = "cpu"
    else:
        device = COQUI_DEVICE
    return device


def load_model(model_name: str) -> TTS:
    global model, current_model_name, sample_rate
    
    dev = get_device()
    logger.info(f"Loading Coqui TTS model '{model_name}' on {dev}...")
    
    try:
        new_model = TTS(model_name=model_name, progress_bar=True)
        if dev == "cuda":
            new_model = new_model.to(dev)
        
        if hasattr(new_model, 'synthesizer') and hasattr(new_model.synthesizer, 'output_sample_rate'):
            sample_rate = new_model.synthesizer.output_sample_rate
        else:
            sample_rate = 22050
        
        model = new_model
        current_model_name = model_name
        logger.info(f"Coqui TTS model loaded successfully (sample_rate={sample_rate})")
        return model
    except Exception as e:
        logger.error(f"Failed to load model '{model_name}': {e}")
        raise


def get_model() -> TTS:
    global model
    if model is None:
        load_model(current_model_name)
    return model


def discover_available_models() -> List[Dict[str, Any]]:
    """Discover all available Coqui TTS models."""
    global available_models_cache
    
    if available_models_cache:
        return available_models_cache
    
    try:
        # Get list of all available models from TTS
        tts_instance = TTS()
        all_models = tts_instance.list_models()
        
        # Filter to TTS models (not vocoder or voice conversion)
        if hasattr(all_models, 'list_models'):
            # Newer TTS versions
            tts_models = [m for m in all_models.list_models() if m.startswith("tts_models/")]
        elif hasattr(all_models, '__iter__'):
            # Older versions or list-like
            tts_models = [m for m in all_models if isinstance(m, str) and m.startswith("tts_models/")]
        else:
            logger.warning(f"Unexpected list_models return type: {type(all_models)}")
            tts_models = []
        
        # Build model info list, prioritizing recommended models
        models = []
        seen_ids = set()
        
        # Add recommended models first
        for rec_model in RECOMMENDED_MODELS:
            models.append(rec_model)
            seen_ids.add(rec_model["id"])
        
        # Add other English models found
        for model_id in tts_models:
            if model_id in seen_ids:
                continue
            if "/en/" in model_id:
                parts = model_id.split("/")
                name = parts[-1].replace("_", " ").replace("-", " ").title() if len(parts) > 2 else model_id
                dataset = parts[2] if len(parts) > 2 else "unknown"
                models.append({
                    "id": model_id,
                    "name": f"{dataset.upper()} {name}",
                    "description": f"English TTS model: {model_id}",
                    "language": "en",
                    "quality": "medium",
                    "speed": "medium"
                })
                seen_ids.add(model_id)
        
        available_models_cache = models
        logger.info(f"Discovered {len(models)} TTS models")
        return models
        
    except Exception as e:
        logger.warning(f"Failed to discover models: {e}")
        return RECOMMENDED_MODELS


@app.on_event("startup")
async def startup_event():
    logger.info("Starting Coqui TTS Server...")
    logger.info(f"Model: {COQUI_MODEL}")
    logger.info(f"Device preference: {COQUI_DEVICE}")
    try:
        get_model()
        logger.info("Coqui TTS model pre-loaded successfully")
    except Exception as e:
        logger.warning(f"Could not pre-load model: {e}. Will load on first request.")
    
    # Pre-discover models in background
    discover_available_models()


@app.get("/health")
async def health():
    return {
        "status": "healthy",
        "model_loaded": model is not None,
        "model_name": current_model_name,
        "device": device,
        "sample_rate": sample_rate,
        "cuda_available": torch.cuda.is_available(),
        "mps_available": hasattr(torch.backends, "mps") and torch.backends.mps.is_available(),
    }


@app.get("/models")
async def list_models():
    """List all available TTS models."""
    models = discover_available_models()
    return {
        "models": models,
        "current_model": current_model_name
    }


@app.post("/models/change")
async def change_model(request: ChangeModelRequest):
    """Change the active TTS model."""
    global model
    
    model_id = request.model_id
    logger.info(f"Changing model to: {model_id}")
    
    # Validate model exists
    available = discover_available_models()
    valid_ids = [m["id"] for m in available]
    
    if model_id not in valid_ids:
        # Try to load anyway - it might be a valid model not in our curated list
        logger.warning(f"Model '{model_id}' not in curated list, attempting to load anyway")
    
    try:
        # Unload current model to free memory
        if model is not None:
            del model
            model = None
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        
        # Load new model
        load_model(model_id)
        
        return {
            "success": True,
            "model": current_model_name,
            "device": device,
            "sample_rate": sample_rate
        }
    except Exception as e:
        logger.error(f"Failed to change model: {e}")
        # Try to reload the previous model
        try:
            if current_model_name != model_id:
                load_model(current_model_name)
        except:
            pass
        raise HTTPException(status_code=500, detail=f"Failed to load model: {str(e)}")


@app.get("/voices")
async def list_voices():
    """List available voices for the current model."""
    tts_model = get_model()
    
    voices = []
    if hasattr(tts_model, 'is_multi_speaker') and tts_model.is_multi_speaker and hasattr(tts_model, 'speakers') and tts_model.speakers:
        for speaker in tts_model.speakers:
            # Check for VCTK metadata
            meta = VCTK_METADATA.get(speaker, {})
            name = speaker.replace("_", " ").title()
            
            if meta:
                desc = f"{meta['desc']} ({meta['gender']}, {meta['accent']})"
                is_recommended = speaker == "p226"
            else:
                desc = f"Speaker: {speaker}"
                is_recommended = False
                
            voices.append({
                "id": speaker,
                "name": name,
                "description": desc,
                "recommended": is_recommended
            })
            
        # Sort voices: recommended first, then numeric/alpha
        voices.sort(key=lambda x: (not x.get("recommended", False), x["id"]))
        
    else:
        # Single speaker model
        model_name = current_model_name.split("/")[-1].replace("_", " ").replace("-", " ").title()
        voices.append({
            "id": "default",
            "name": model_name,
            "description": f"Default voice for {current_model_name}"
        })
    
    return {
        "voices": [v["id"] for v in voices],
        "voice_details": voices,
        "is_multi_speaker": hasattr(tts_model, 'is_multi_speaker') and tts_model.is_multi_speaker
    }


@app.post("/synthesize")
async def synthesize(request: SynthesizeRequest):
    """Synthesize speech from text."""
    text = request.input or request.text
    voice_id = request.voice
    speed = request.speed
    
    if not text:
        raise HTTPException(status_code=400, detail="No text provided")
    
    if len(text) > 4096:
        raise HTTPException(status_code=400, detail="Text too long (max 4096 characters)")
    
    try:
        tts_model = get_model()
        
        logger.info(f"Synthesizing text with voice '{voice_id}', speed={speed}")
        
        kwargs = {}
        if hasattr(tts_model, 'is_multi_speaker') and tts_model.is_multi_speaker and voice_id != "default":
            kwargs["speaker"] = voice_id
        if hasattr(tts_model, 'is_multi_lingual') and tts_model.is_multi_lingual:
            kwargs["language"] = "en"
        
        wav = tts_model.tts(text=text, **kwargs)
        
        wav_np = np.array(wav, dtype=np.float32)
        
        if wav_np.max() > 1.0 or wav_np.min() < -1.0:
            wav_np = wav_np / max(abs(wav_np.max()), abs(wav_np.min()))
        
        wav_int16 = (wav_np * 32767).astype(np.int16)
        
        buffer = io.BytesIO()
        wavfile.write(buffer, sample_rate, wav_int16)
        buffer.seek(0)
        
        return StreamingResponse(
            buffer,
            media_type="audio/wav",
            headers={
                "Content-Disposition": "inline; filename=speech.wav"
            }
        )
        
    except Exception as e:
        logger.error(f"Synthesis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/v1/audio/speech")
async def openai_compatible_synthesize(request: dict):
    """OpenAI-compatible speech synthesis endpoint."""
    text = request.get("input")
    voice = request.get("voice", "default")
    speed = request.get("speed", 1.0)
    response_format = request.get("response_format", "wav")
    
    if not text:
        raise HTTPException(status_code=400, detail="No input text provided")
    
    if len(text) > 4096:
        raise HTTPException(status_code=400, detail="Text too long (max 4096 characters)")
    
    try:
        tts_model = get_model()
        
        logger.info(f"OpenAI-compatible synthesis: voice='{voice}', format='{response_format}'")
        
        kwargs = {}
        if hasattr(tts_model, 'is_multi_speaker') and tts_model.is_multi_speaker and voice != "default":
            kwargs["speaker"] = voice
        if hasattr(tts_model, 'is_multi_lingual') and tts_model.is_multi_lingual:
            kwargs["language"] = "en"
        
        wav = tts_model.tts(text=text, **kwargs)
        
        wav_np = np.array(wav, dtype=np.float32)
        if wav_np.max() > 1.0 or wav_np.min() < -1.0:
            wav_np = wav_np / max(abs(wav_np.max()), abs(wav_np.min()))
        wav_int16 = (wav_np * 32767).astype(np.int16)
        
        buffer = io.BytesIO()
        wavfile.write(buffer, sample_rate, wav_int16)
        buffer.seek(0)
        
        return StreamingResponse(
            buffer,
            media_type="audio/wav"
        )
        
    except Exception as e:
        logger.error(f"OpenAI-compatible synthesis error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/v1/audio/voices")
async def openai_compatible_list_voices():
    """OpenAI-compatible voice listing endpoint."""
    voices_data = await list_voices()
    return {
        "data": [
            {
                "id": v["id"],
                "name": v["name"],
                "description": v.get("description", ""),
            }
            for v in voices_data["voice_details"]
        ]
    }


if __name__ == "__main__":
    port = int(os.environ.get("COQUI_PORT", "5554"))
    host = os.environ.get("COQUI_HOST", "127.0.0.1")
    
    logger.info(f"Starting Coqui TTS server on {host}:{port}")
    uvicorn.run(app, host=host, port=port, log_level="info")
