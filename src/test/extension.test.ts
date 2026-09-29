import * as assert from 'assert';
import { parseTestListing } from '../extension';


suite('Cargo test discovery', () => {
	test('parses terse Cargo test listings', () => {
		const listing = 'crate::works: test\ncrate::ignored: test\n2 tests, 0 benchmarks';
		assert.deepStrictEqual(parseTestListing(listing), ['crate::works', 'crate::ignored']);
	});
});
