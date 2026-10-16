import math
import unittest

from pitch_helpers import edges_and_noise, ending_semitones, sound_frames


class EndingTest(unittest.TestCase):
    def test_flat(self):
        self.assertAlmostEqual(ending_semitones([120.0] * 50), 0.0)

    def test_falling_ending(self):
        # 40 frames at 200 Hz, then 10 at 100 Hz: the last fifth is one octave lower
        self.assertAlmostEqual(ending_semitones([200.0] * 40 + [100.0] * 10), -12.0)

    def test_rising_ending(self):
        self.assertGreater(ending_semitones([100.0] * 40 + [150.0] * 10), 0)

    def test_unvoiced_frames_are_ignored(self):
        f = [200.0] * 40 + [math.nan] * 30 + [100.0] * 10 + [0.0] * 5
        self.assertAlmostEqual(ending_semitones(f), -12.0)

    def test_too_few_voiced_frames(self):
        self.assertIsNone(ending_semitones([120.0] * 9 + [math.nan] * 40))


class NonSpeechTest(unittest.TestCase):
    def test_sound_frames_relative_to_the_loud_part(self):
        rms = [0.0] * 5 + [0.2] * 20 + [0.005] * 5
        # 0.04 × 0.2 = 0.008 is the level: 0.005 is quiet
        self.assertEqual(sound_frames(rms), [False] * 5 + [True] * 20 + [False] * 5)

    def test_absolute_floor(self):
        self.assertEqual(sound_frames([0.003] * 4), [False] * 4)

    def test_lead_tail_noise(self):
        voiced = [False] * 4 + [True] * 10 + [False] * 2 + [True] * 10 + [False] * 6
        sound = [False] * 2 + [True] * 2 + [True] * 10 + [True] * 2 + [True] * 10 + [True] * 3 + [False] * 3
        r = edges_and_noise(voiced, sound, 0.01)
        self.assertAlmostEqual(r["lead_s"], 0.02)
        self.assertAlmostEqual(r["tail_s"], 0.03)
        self.assertAlmostEqual(r["noise_s"], 0.07)

    def test_no_voice(self):
        self.assertEqual(
            edges_and_noise([False] * 3, [True] * 3, 0.01), {"lead_s": 0.0, "tail_s": 0.0, "noise_s": 0.03}
        )


if __name__ == "__main__":
    unittest.main()
