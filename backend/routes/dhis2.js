'use strict';
// DHIS2 integration routes — reports/export endpoints
module.exports = function registerDhis2Routes(app) {
  app.get('/api/dhis2/reports', (req, res) => {
    res.json({ modules: ['HMIS105', 'HMIS106', 'DHIS2 Export', 'NDW Export'] });
  });
};
