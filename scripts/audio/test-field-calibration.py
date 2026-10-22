#!/usr/bin/env python3
"""Short regressions for evidence scope, missing data and acoustic ambiguity."""
import importlib.util
from pathlib import Path
import unittest
from unittest.mock import patch

import numpy as np

spec = importlib.util.spec_from_file_location('field', Path(__file__).with_name('field-audio.py'))
field = importlib.util.module_from_spec(spec)
spec.loader.exec_module(field)


class EvidenceTests(unittest.TestCase):
    def test_single_sample_has_no_standard_error(self):
        self.assertEqual(field.stats([60]), dict(n=1, mean=60, sd=None, se=None, minimum=60, maximum=60))
        self.assertIsNone(field.stats([])['mean'])

    def test_standard_error_uses_sample_deviation(self):
        result = field.stats([0, 60, 120])
        self.assertAlmostEqual(result['sd'], 60)
        self.assertAlmostEqual(result['se'], 60 / 3 ** .5)

    def test_period_boundary_is_half_open(self):
        bands = [dict(name='晚高峰', **{'from': '17:00', 'to': '20:30'}),
                 dict(name='其他时段', **{'from': None, 'to': None})]
        self.assertEqual(field.period(20 * 3600 + 30 * 60 - .1, bands), '晚高峰')
        self.assertEqual(field.period(20 * 3600 + 30 * 60, bands), '其他时段')
        self.assertEqual(field.period(17 * 3600 - .1, bands), '其他时段')
        self.assertEqual(field.period(17 * 3600, bands), '晚高峰')

    def test_missing_or_weak_evidence_cannot_enter_primary_mean(self):
        self.assertEqual(field.confidence('high', None), 'low')
        self.assertEqual(field.confidence('high', 'low'), 'low')
        self.assertEqual(field.confidence('high', 'medium'), 'medium')

    def test_constant_acoustic_line_is_not_a_speed_measurement(self):
        t = np.arange(80 * 8000) / 8000
        result = field.pitch_platforms(np.sin(2 * np.pi * 900 * t).astype('float32'), 0, 80)
        self.assertIsNone(result['speedKmh'])
        self.assertTrue(result['plateaus'])
        self.assertTrue(all(abs(p['hz'] - 900) < 3 for p in result['plateaus']))

    def test_next_announcement_is_not_an_arrival(self):
        segments = [dict(start=10, end=12, text='下一站'), dict(start=12, end=14, text='唐镇，开左边门')]
        result = field.announcement_hits(segments, ['广兰路', '唐镇'])
        self.assertEqual([(r['station'], r['type']) for r in result], [('唐镇', 'next')])

    def test_clock_rejects_invalid_minutes(self):
        with self.assertRaises(ValueError):
            field.clock_seconds('20:99')

    def test_door_delay_ranges_are_read_as_inputs_and_half_widths_add(self):
        events = [dict(station='test', open=dict(at=12, confidence='medium'), close=dict(at=30, confidence='high'), stop=None, start=None)]
        row = field.infer_door_events(events, dict(openDelay=[1,3], startDelay=[2,6], closeS=4))[0]
        self.assertEqual(row['stop']['at'], 10)
        self.assertEqual(row['start']['at'], 38)
        self.assertEqual(row['stop']['uncertaintyS'] + row['start']['uncertaintyS'], 3)

    def test_lock_sound_takes_precedence_over_warning(self):
        row = dict(station='test', open=None, close=dict(at=30, confidence='high'), locked=dict(at=37, confidence='medium'), stop=None, start=None)
        field.infer_door_events([row], dict(openDelay=[1,3], startDelay=[2,6], closeS=4))
        self.assertEqual(row['start']['at'], 41)
        self.assertEqual(row['start']['method'], 'door-lock-plus-start-delay')

    def test_departure_disagreement_retains_motor_cue_and_reports_it(self):
        row = dict(station='test', open=None, close=dict(at=30, confidence='high'), stop=None, start=dict(at=60, confidence='medium'))
        field.infer_door_events([row], dict(openDelay=[1,3], startDelay=[2,6], closeS=4))
        self.assertEqual(row['start']['at'], 60)
        self.assertEqual(row['doorStart']['at'], 38)
        self.assertEqual(row['discrepancies'][0]['motorMinusDoorS'], 22)
        self.assertIsNone(row['start']['uncertaintyS'])

    def test_clipped_origin_does_not_shift_the_first_warning_back_one_station(self):
        source = dict(id='synthetic', stationOrder=['中山公园', '娄山关路', '威宁路'], fromStation='中山公园',
                      **{'from': '中山公园'}, directions=['UP'], offset=0)
        hints = [dict(type='next', station='娄山关路', range=[30, 40]), dict(type='next', station='威宁路', range=[170, 190])]
        with patch.object(field, 'recognize_announcements', return_value=(hints, 'test')), \
             patch.object(field.tones, 'detect_tones', return_value=[dict(start=150, end=156)]), \
             patch.object(field, 'stop_in_window', side_effect=lambda audio, window, source, station: dict(at=130 if station == '娄山关路' else 289)), \
             patch.object(field.starts, 'refine_start', return_value=dict(at=159)):
            events = field.automatic_events(np.zeros(300 * 8000, dtype='float32'), source, Path('.'), 300)
        self.assertEqual([e['station'] for e in events], ['中山公园', '娄山关路', '威宁路'])
        self.assertIsNone(events[0]['start'])
        self.assertIsNone(events[0]['stop'])
        self.assertEqual(events[1]['stop']['at'], 130)
        self.assertEqual(events[2]['stop']['at'], 289)


if __name__ == '__main__':
    unittest.main()
