"""
Gera a narração do vídeo de onboarding via edge-tts (gratuito, local) —
mesmo padrão já usado no BI-DAP (ver scripts/video/README.md daquele
projeto). Uma parte de áudio por cena do roteiro (narracao-texto.json),
depois concatenadas com ffmpeg numa trilha única.

Uso:
    python scripts/video/narracao.py

Saída: scripts/video/build/narracao/<NN>-<slug>.mp3 (uma por parte) +
scripts/video/build/narracao-full.mp3 (concatenada, consumida por
build.mjs).

Pré-requisitos: pip install edge-tts ; ffmpeg no PATH.
"""
import asyncio
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
BUILD_DIR = os.path.join(HERE, "build")
NARR_DIR = os.path.join(BUILD_DIR, "narracao")
os.makedirs(NARR_DIR, exist_ok=True)


async def gen_one(voice, rate, text, out_path):
    import edge_tts
    communicate = edge_tts.Communicate(text, voice, rate=rate)
    await communicate.save(out_path)


async def main():
    with open(os.path.join(HERE, "narracao-texto.json"), "r", encoding="utf-8") as f:
        data = json.load(f)
    voice = data["voice"]
    rate = data["rate"]
    parts = data["parts"]

    generated = []
    for i, part in enumerate(parts):
        out_path = os.path.join(NARR_DIR, f"{i:02d}-{part['slug']}.mp3")
        print(f"-> gerando {part['slug']} ...", end=" ", flush=True)
        await gen_one(voice, rate, part["text"], out_path)
        print("ok")
        generated.append(out_path)

    # Concatena tudo numa trilha única (mesmo padrão do BI-DAP: concat
    # demuxer do ffmpeg, sem reencode entre as partes já que todas saem
    # do mesmo gerador/formato).
    concat_list = os.path.join(NARR_DIR, "concat.txt")
    with open(concat_list, "w", encoding="utf-8") as f:
        for p in generated:
            f.write(f"file '{p}'\n")

    full_path = os.path.join(BUILD_DIR, "narracao-full.mp3")
    subprocess.run(
        ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list, "-c", "copy", full_path],
        check=True,
    )
    print(f"\nNarração completa: {full_path}")

    # Duração de cada parte (precisa em build.mjs pra casar o corte de
    # cada cena com o tempo real da fala, não a estimativa do roteiro).
    durations = {}
    for i, part in enumerate(parts):
        p = generated[i]
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p],
            capture_output=True, text=True, check=True,
        )
        durations[part["slug"]] = float(result.stdout.strip())

    with open(os.path.join(BUILD_DIR, "narracao-durations.json"), "w", encoding="utf-8") as f:
        json.dump(durations, f, indent=2, ensure_ascii=False)
    print("Durações salvas em build/narracao-durations.json:")
    for slug, dur in durations.items():
        print(f"  {slug}: {dur:.2f}s")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except ModuleNotFoundError:
        print("Falta instalar: pip install edge-tts", file=sys.stderr)
        sys.exit(1)
