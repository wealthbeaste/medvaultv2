# Batch Number Requirements

The **batch_number** field is used to uniquely identify a batch of a drug within a pharmacy.

## Database Constraints
- Stored as `VARCHAR(100)` in the `drug_batches` table.
- A **unique composite index** `idx_unique_batch` enforces uniqueness of the combination `(drug_id, batch_number)`.

## API Validation
- When creating a new drug (`POST /api/inventory`), `batch_number` is required and must be a non‑empty string.
- The endpoint returns **400 Bad Request** if the value is missing or invalid.

## Update Endpoint
- `PUT /api/batch/:id` allows updating `batch_number`, `expiry_date`, `quantity`, and `cost_price`.
- Returns **409 Conflict** if the new `batch_number` would violate the unique constraint.

## Front‑end Usage
- All forms that create or edit drug batches must provide a non‑empty batch number.
- Display error messages returned from the API to guide the user.

## Error Handling
- Duplicate batch numbers trigger a `23505` PostgreSQL error, which is caught and translated to a `409` response with the message `Duplicate batch_number for this drug`.

Ensure any new integrations respect these rules to maintain data integrity.