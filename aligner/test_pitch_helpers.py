import math
import unittest

from pitch_helpers import ending_semitones


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


if __name__ == "__main__":
    unittest.main()
