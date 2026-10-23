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

    def test_user_review_overrides_old_events_and_reference_without_losing_either(self):
        review = dict(recording='ride-east', station='test', reviewedOn='2026-10-23', clipWindowS=[10, 50], reply='review',
                      events=dict(open=dict(at=17, confidence='medium', method='user-review', rangeS=[16, 18]),
                                  close=dict(at=35, confidence='high', method='user-review'),
                                  closingMotion=dict(at=37, confidence='high', method='user-review'),
                                  locked=dict(at=39, confidence='high', method='user-review')))
        source = dict(id='ride-east', doorReviews=[review])
        row = dict(station='test', open=dict(at=12, confidence='high'), close=dict(at=30, confidence='high'),
                   locked=dict(at=37, confidence='high'), stop=dict(at=10, confidence='medium'), start=dict(at=41, confidence='medium'))
        timing = dict(openDelay=[1, 3], startDelay=[2, 6], closeS=4,
                      referenceTakes=[dict(station='test', open=[14, 15], lockedAt=38, confidence='high')])
        with patch.object(field.tones, 'detect_tones', return_value=[]), patch.object(field.motion, 'opening_cue') as search:
            field.measure_doors(np.zeros(60 * 8000, dtype='float32'), source, [row], timing)
        search.assert_not_called()
        self.assertEqual(row['doorReview'], review)
        self.assertEqual(row['open']['at'], 17)
        self.assertEqual(row['closingMotion']['at'], 37)
        self.assertEqual(row['locked']['at'], 39)
        self.assertEqual(row['stop']['at'], 15)
        self.assertEqual(row['start']['at'], 43)
        self.assertEqual(row['stop']['acoustic']['rangeS'], [16, 18])
        self.assertEqual(row['stop']['uncertaintyS'], 1)  # Delay only; not the user's acoustic range.
        self.assertEqual(row['reviewPriorEvents']['open']['at'], 12)
        self.assertEqual(row['reviewPriorEvents']['stop']['at'], 10)
        self.assertEqual(row['reviewPriorEvents']['referenceEvents']['open']['at'], 14)
        self.assertEqual(row['reviewPriorEvents']['referenceEvents']['locked']['at'], 38)

    def test_negative_opening_window_cannot_be_revived_by_automatic_search(self):
        review = dict(recording='ride-east', station='金科路', reviewedOn='2026-10-23', clipWindowS=[2124, 2147],
                      reply='no opening heard', openingNotHeard=True,
                      events=dict(close=dict(at=2138, confidence='high', method='user-review'),
                                  closingMotion=dict(at=2141, confidence='high', method='user-review'),
                                  locked=dict(at=2144, confidence='high', method='user-review')))
        row = dict(station='金科路', open=dict(at=2135.98, confidence='low'), close=dict(at=2141, confidence='low'),
                   stop=dict(at=2134.98, confidence='low'), start=dict(at=2148, confidence='low'))
        timing = dict(openDelay=[0, 2], startDelay=[1.5, 3.5], closeS=5.7,
                      referenceTakes=[dict(station='金科路', open=[2136, 2137], lockedAt=2145, confidence='high')])
        with patch.object(field.tones, 'detect_tones', return_value=[]), \
             patch.object(field.motion, 'features') as features, patch.object(field.motion, 'opening_cue') as search:
            field.measure_doors(np.zeros(2150 * 8000, dtype='float32'), dict(id='ride-east', doorReviews=[review]), [row], timing)
        features.assert_not_called()
        search.assert_not_called()
        self.assertIsNone(row['open'])
        self.assertIsNone(row['stop'])
        self.assertEqual(row['start']['at'], 2146.5)
        self.assertEqual(row['start']['method'], 'door-lock-plus-start-delay')
        self.assertTrue(row['doorReview']['openingNotHeard'])
        self.assertEqual(row['reviewPriorEvents']['open']['at'], 2135.98)

    def test_negative_clip_does_not_reject_an_existing_opening_outside_the_clip(self):
        review = dict(recording='test', station='test', reviewedOn='2026-10-23', clipWindowS=[20, 30], reply='not in this clip', openingNotHeard=True)
        row = dict(station='test', open=dict(at=12, confidence='medium'), close=None, stop=dict(at=10, confidence='low'), start=None)
        with patch.object(field.tones, 'detect_tones', return_value=[]), patch.object(field.motion, 'opening_cue') as search:
            field.measure_doors(np.zeros(60 * 8000, dtype='float32'), dict(id='test', doorReviews=[review]), [row],
                                dict(openDelay=[1, 3], startDelay=[2, 6], closeS=4, referenceTakes=[]))
        search.assert_not_called()
        self.assertEqual(row['open']['at'], 12)
        self.assertEqual(row['stop']['at'], 10)

    def test_automatic_opening_search_is_split_before_searching_a_negative_clip(self):
        review = dict(recording='test', station='test', reviewedOn='2026-10-23', clipWindowS=[20, 30], reply='not in this clip', openingNotHeard=True)
        row = dict(station='test', open=None, close=dict(at=40, confidence='high'), stop=dict(at=25, confidence='low'), start=None)
        windows = []
        def opening(_data, window):
            windows.append(window)
            return None if len(windows) == 1 else dict(at=window[0] + 1, confidence='low', method='candidate')
        with patch.object(field.tones, 'detect_tones', return_value=[]), patch.object(field.motion, 'features', return_value={}), \
             patch.object(field.motion, 'opening_cue', side_effect=opening):
            field.measure_doors(np.zeros(60 * 8000, dtype='float32'), dict(id='test', doorReviews=[review]), [row],
                                dict(openDelay=[1, 3], startDelay=[2, 6], closeS=4, referenceTakes=[]))
        self.assertEqual(windows, [[2, 7], [2, 8]])  # Actual source windows [15,20], [30,36].
        self.assertEqual(row['open']['searchWindowS'], [30, 36])
        self.assertEqual(row['open']['at'], 31)
        self.assertEqual(row['open']['confidence'], 'low')

    def test_reviewed_lock_still_reports_a_conflicting_independent_motor_start(self):
        review = dict(recording='test', station='test', reviewedOn='2026-10-23', clipWindowS=[20, 40], reply='locked',
                      events=dict(locked=dict(at=37, confidence='high', method='user-review')))
        row = dict(station='test', open=None, close=dict(at=30, confidence='high'), stop=None, start=dict(at=60, confidence='medium'))
        with patch.object(field.tones, 'detect_tones', return_value=[]):
            field.measure_doors(np.zeros(70 * 8000, dtype='float32'), dict(id='test', doorReviews=[review]), [row],
                                dict(openDelay=[1, 3], startDelay=[2, 6], closeS=4, referenceTakes=[]))
        self.assertEqual(row['start']['at'], 60)
        self.assertEqual(row['doorStart']['at'], 41)
        self.assertEqual(row['discrepancies'][0]['motorMinusDoorS'], 19)

    def test_presence_only_tail_review_does_not_upgrade_timing_or_primary_mean(self):
        review = dict(recording='ride-east', station='广兰路', reviewedOn='2026-10-23', clipWindowS=[2295, 2311.66], reply='opening exists',
                      events=dict(open=dict(at=2310.82, confidence='low', method='candidate-with-user-presence-review',
                                            presenceConfirmed=True, timingConfirmed=False, edgeLimited=True)))
        row = dict(station='广兰路', open=dict(at=2310.82, confidence='low'), close=None, stop=dict(at=2309.82, confidence='low'), start=None)
        with patch.object(field.tones, 'detect_tones', return_value=[]), patch.object(field.motion, 'opening_cue') as search:
            field.measure_doors(np.zeros(2312 * 8000, dtype='float32'), dict(id='ride-east', doorReviews=[review]), [row],
                                dict(openDelay=[0, 2], startDelay=[1.5, 3.5], closeS=5.7, referenceTakes=[]))
        search.assert_not_called()
        self.assertEqual(row['stop']['confidence'], 'low')
        self.assertEqual(field.confidence('high', row['stop']['confidence']), 'low')
        self.assertTrue(row['stop']['acoustic']['presenceConfirmed'])
        self.assertFalse(row['stop']['acoustic']['timingConfirmed'])
        self.assertTrue(row['stop']['acoustic']['edgeLimited'])
        self.assertEqual(row['stop']['uncertaintyS'], 1)

    def test_model_clock_keeps_exact_input_lower_bound_and_unknown_scenarios_distinct(self):
        bands = [dict(name='晚高峰', **{'from': '17:00', 'to': '20:30'}),
                 dict(name='其他时段', **{'from': None, 'to': None})]
        with patch.object(field, 'HEADWAY_BANDS', bands):
            exact = field.measurement_clock(dict(clockStart='19:51', clockStartPrecision='minute', clockStartNotBefore='19:50'), 10)
            lower = field.measurement_clock(dict(clockStart=None, clockStartNotBefore='19:50'), 10)
            unknown = field.measurement_clock({}, 10)
        self.assertEqual(exact['modelClock'], 19 * 3600 + 51 * 60 + 10)
        self.assertEqual(exact['period'], '晚高峰')
        self.assertEqual(lower['modelClock'], 19 * 3600 + 50 * 60 + 10)
        self.assertEqual(lower['period'], '钟点下界情景；19:50')
        self.assertEqual(lower['clockBasis'], 'user-confirmed lower bound scenario; exact start unknown')
        self.assertNotIn('filename', lower['clockBasis'])
        self.assertEqual(unknown['modelClock'], 22 * 3600 + 10)
        self.assertEqual(unknown['period'], '钟点未知；22:00情景')
        self.assertTrue(all(not row['clockReliable'] for row in [exact, lower, unknown]))

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
