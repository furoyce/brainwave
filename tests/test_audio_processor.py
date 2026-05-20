import pytest
import numpy as np
import wave
import os
from main import AudioProcessor

@pytest.fixture
def audio_processor():
    return AudioProcessor()

def test_init():
    processor = AudioProcessor(target_sample_rate=16000)
    assert processor.target_sample_rate == 16000
    assert processor.source_sample_rate == 48000

def test_process_audio_chunk(audio_processor):
    # Create a test audio chunk (1 second of 440Hz sine wave)
    duration = 1.0
    t = np.linspace(0, duration, int(48000 * duration), False)
    test_audio = np.sin(2 * np.pi * 440 * t)
    test_audio = (test_audio * 32767).astype(np.int16).tobytes()

    # Process the audio chunk
    processed_audio = audio_processor.process_audio_chunk(test_audio)

    # Check the output is bytes
    assert isinstance(processed_audio, bytes)

    # Convert processed audio back to numpy array for analysis
    processed_samples = np.frombuffer(processed_audio, dtype=np.int16)

    # Check the sample rate conversion (48000 -> 24000)
    expected_length = int(len(test_audio) / 2 * (24000 / 48000))
    assert len(processed_audio) == expected_length * 2  # *2 because int16 is 2 bytes

def test_save_audio_buffer(audio_processor, tmp_path):
    # Create a test audio buffer
    duration = 0.1
    t = np.linspace(0, duration, int(24000 * duration), False)
    test_audio = np.sin(2 * np.pi * 440 * t)
    test_audio = (test_audio * 32767).astype(np.int16).tobytes()

    # Save the audio buffer
    test_filename = tmp_path / "test_audio.wav"
    audio_processor.save_audio_buffer([test_audio], str(test_filename))

    # Verify the saved file
    assert test_filename.exists()

    # Read the saved file and verify its properties
    with wave.open(str(test_filename), 'rb') as wav_file:
        assert wav_file.getnchannels() == 1  # Mono
        assert wav_file.getsampwidth() == 2  # 16-bit
        assert wav_file.getframerate() == audio_processor.target_sample_rate
        
        # Read the audio data
        audio_data = wav_file.readframes(wav_file.getnframes())
        assert len(audio_data) == len(test_audio)
        
        # Compare the audio data
        np.testing.assert_array_equal(
            np.frombuffer(audio_data, dtype=np.int16),
            np.frombuffer(test_audio, dtype=np.int16)
        )
