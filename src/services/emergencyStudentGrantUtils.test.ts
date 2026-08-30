/**
 * Unit Tests for Emergency Student Grant Relief Utilities
 */

import { describe, it, expect } from 'vitest';
import { calculateEmergencyStudentGrant } from './emergencyStudentGrantUtils';

describe('EmergencyStudentGrantUtils', () => {
  it('should approve housing emergency relief grant up to 1500 USD limit', () => {
    const res = calculateEmergencyStudentGrant('HOUSING', 1200);
    expect(res.approvedGrantAmountUSD).toBe(1200);
    expect(res.reliefType).toBe('HOUSING_RENT_RELIEF');
  });
});
