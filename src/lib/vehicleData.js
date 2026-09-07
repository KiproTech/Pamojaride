// ============================================================================
// Reference data for the driver verification form's searchable dropdowns.
// Purely a frontend UX aid — vehicle_make/vehicle_model/vehicle_color on
// driver_profiles remain plain free-text columns (as they already were),
// so picking a value here or typing a custom "Other" value both just write
// a normal string. No schema change needed for these three.
// ============================================================================

// Common models per make, tuned toward the Kenyan/East African used-import
// market. Not exhaustive — anything not listed falls under "Other" and the
// driver types it manually, same as picking "Other" for the make itself.
export const VEHICLE_MAKE_MODELS = {
  Toyota: ['Corolla', 'Corolla Fielder', 'Axio', 'Premio', 'Allion', 'Vitz', 'Passo', 'Wish',
    'Noah', 'Voxy', 'Sienta', 'RAV4', 'Harrier', 'Prado', 'Land Cruiser', 'Hilux', 'Hiace', 'Probox'],
  Nissan: ['Note', 'March', 'Tiida', 'Sylphy', 'X-Trail', 'Juke', 'Advan', 'NV200', 'Navara', 'Patrol'],
  Subaru: ['Impreza', 'Forester', 'Outback', 'Legacy', 'XV'],
  Mazda: ['Demio', 'Axela', 'Atenza', 'CX-5', 'CX-3', 'Premacy', 'Bongo'],
  Honda: ['Fit', 'Vezel', 'CR-V', 'Civic', 'Accord', 'Freed', 'Stream'],
  'Mercedes-Benz': ['C-Class', 'E-Class', 'S-Class', 'GLC', 'GLE', 'Vito', 'Sprinter'],
  BMW: ['3 Series', '5 Series', 'X1', 'X3', 'X5'],
  Volkswagen: ['Golf', 'Polo', 'Passat', 'Tiguan', 'Transporter'],
  Mitsubishi: ['Lancer', 'Outlander', 'Pajero', 'ASX', 'Delica', 'Canter'],
  Isuzu: ['D-Max', 'NPR', 'NQR', 'FRR', 'Trooper'],
  Ford: ['Focus', 'Fiesta', 'Ranger', 'Everest', 'EcoSport'],
  Hyundai: ['Tucson', 'Elantra', 'i10', 'i20', 'Accent', 'H-1', 'County'],
  Kia: ['Sportage', 'Rio', 'Sorento', 'Picanto', 'Cerato'],
  Peugeot: ['208', '308', '3008', '5008', 'Partner'],
  Suzuki: ['Alto', 'Swift', 'Vitara', 'Every'],
  'Land Rover': ['Discovery', 'Range Rover', 'Defender', 'Freelander'],
};

export const VEHICLE_MAKES = [...Object.keys(VEHICLE_MAKE_MODELS), 'Other'];

export const VEHICLE_COLORS = [
  'Black', 'White', 'Silver', 'Grey', 'Red', 'Blue', 'Green', 'Brown', 'Beige', 'Yellow', 'Orange', 'Other',
];
