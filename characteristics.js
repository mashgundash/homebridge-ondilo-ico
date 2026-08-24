'use strict';

// Eve ne définit aucune caractéristique de pH, d'ORP, de salinité ni de TDS, et HAP non plus :
// ces UUID sont donc propres au plugin. Ils sont volontairement hors de la plage E863F1xx
// réservée par Eve — une collision y ferait afficher n'importe quelle grandeur dans Eve.
// Ils ne doivent jamais changer : un contrôleur les mémorise avec l'accessoire appairé.
const UUID_PH = '4963F37B-02F1-4905-851F-00FADC47407A';
const UUID_ORP = '3C0DC683-7657-470F-A802-9D0FE586ED6A';
const UUID_SALINITY = '9DA1F226-B466-45B3-B8A9-5CC10DAEFB5C';
const UUID_TDS = 'E1C97A76-4FF2-40C6-883F-526B67675E91';

function createCustomCharacteristics(hap) {
  const { Characteristic, Formats, Perms } = hap;
  const readOnly = [Perms.PAIRED_READ, Perms.NOTIFY];

  class WaterPh extends Characteristic {
    constructor() {
      super('pH', WaterPh.UUID, {
        format: Formats.FLOAT,
        perms: readOnly,
        minValue: 0,
        maxValue: 14,
        minStep: 0.01,
      });
      this.value = this.getDefaultValue();
    }
  }
  WaterPh.UUID = UUID_PH;

  class WaterOrp extends Characteristic {
    constructor() {
      super('ORP', WaterOrp.UUID, {
        format: Formats.FLOAT,
        perms: readOnly,
        unit: 'mV',
        minValue: 0,
        maxValue: 2000,
        minStep: 1,
      });
      this.value = this.getDefaultValue();
    }
  }
  WaterOrp.UUID = UUID_ORP;

  class WaterSalinity extends Characteristic {
    constructor() {
      super('Salinité', WaterSalinity.UUID, {
        format: Formats.FLOAT,
        perms: readOnly,
        unit: 'mg/L',
        minValue: 0,
        maxValue: 20000,
        minStep: 1,
      });
      this.value = this.getDefaultValue();
    }
  }
  WaterSalinity.UUID = UUID_SALINITY;

  class WaterTds extends Characteristic {
    constructor() {
      super('TDS', WaterTds.UUID, {
        format: Formats.FLOAT,
        perms: readOnly,
        unit: 'ppm',
        minValue: 0,
        maxValue: 10000,
        minStep: 1,
      });
      this.value = this.getDefaultValue();
    }
  }
  WaterTds.UUID = UUID_TDS;

  return { WaterPh, WaterOrp, WaterSalinity, WaterTds };
}

module.exports = {
  createCustomCharacteristics,
  UUID_PH,
  UUID_ORP,
  UUID_SALINITY,
  UUID_TDS,
};
