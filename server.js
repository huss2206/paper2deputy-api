const path = require('path');
const envPath = path.resolve(__dirname, '.env');
require('dotenv').config({ path: envPath });

// Add error handling for missing API key
if (!process.env.GOOGLE_API_KEY) {
  console.error('ERROR: GOOGLE_API_KEY is not set in environment variables');
  console.error('Looking for .env file at:', envPath);
  process.exit(1); // Exit the process if the key is missing
}

const express = require('express');
const cors = require('cors');
const axios = require('axios');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const multer = require('multer');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());

const DEPUTY_BASE_URL = process.env.DEPUTY_BASE_URL;
const DEPUTY_ACCESS_TOKEN = process.env.DEPUTY_ACCESS_TOKEN;
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
const API_URL = process.env.API_URL;

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  }
});

// Helper function to convert file buffer to base64
function fileToGenerativePart(buffer, mimeType) {
  return {
    inlineData: {
      data: buffer.toString('base64'),
      mimeType
    }
  };
}

// this is the endpoint for creating a shift in Deputy
app.post('/api/deputy/add-shift', async (req, res) => {
  try {
    const response = await axios.post(
      `${DEPUTY_BASE_URL}/api/v1/supervise/roster`,
      req.body,
      {
        headers: {
          'Authorization': `Bearer ${DEPUTY_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      message: error.message,
      details: error.response?.data
    });
  }
});

//this is the endpoint for getting all employees from Deputy
app.get('/api/deputy/employees', async (req, res) => {
  try {
    const response = await axios.get(
      `${DEPUTY_BASE_URL}/api/v1/resource/Employee`,
      {
        headers: {
          'Authorization': `Bearer ${DEPUTY_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      message: error.message,
      details: error.response?.data
    });
  }
});

//this is the endpoint for getting all locations from Deputy
app.get('/api/deputy/locations', async (req, res) => {
  try {
    const response = await axios.get(
      `${DEPUTY_BASE_URL}/api/v1/resource/Company`,
      {
        headers: {
          'Authorization': `Bearer ${DEPUTY_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );
    res.json(response.data);
  } catch (error) {
    res.status(error.response?.status || 500).json({
      message: error.message,
      details: error.response?.data
    });
  }
});

// Helper function to find the best matching employee
const findBestMatchingEmployee = (nameFromImage, employees) => {
  if (!nameFromImage || typeof nameFromImage !== 'string') {
    return null;
  }

  // Convert both strings to lowercase for comparison
  const normalizedName = nameFromImage.toLowerCase().trim();
  
  // First try exact match
  let match = employees.find(emp => 
    emp.DisplayName.toLowerCase().trim() === normalizedName
  );
  
  // If no exact match, try partial matches
  if (!match) {
    match = employees.find(emp => 
      normalizedName.includes(emp.DisplayName.toLowerCase().trim()) ||
      emp.DisplayName.toLowerCase().trim().includes(normalizedName)
    );
  }
  
  // If still no match, try matching first name
  if (!match) {
    match = employees.find(emp => {
      const employeeFirstName = emp.DisplayName.split(' ')[0].toLowerCase().trim();
      return normalizedName.includes(employeeFirstName) ||
             employeeFirstName.includes(normalizedName);
    });
  }
  
  return match;
};

// Main function to process Gemini payload
const processGeminiPayload = async (geminiPayload) => {
  try {
    // Fetch employees from Deputy
    const employeesResponse = await axios.get(`${API_URL}/api/deputy/employees`);
    const employees = employeesResponse.data;

    // Extract name from either intRosterEmployee or comment
    const employeeName = typeof geminiPayload.intRosterEmployee === 'string' 
      ? geminiPayload.intRosterEmployee 
      : (geminiPayload.strComment || '').match(/for\s+([^,\.]+)/i)?.[1]?.trim();

    if (employeeName) {
      const matchedEmployee = findBestMatchingEmployee(employeeName, employees);

      if (!matchedEmployee) {
        throw new Error(`Employee "${employeeName}" not found in Deputy. Please create this employee in Deputy first.`);
      }

      return {
        originalPayload: geminiPayload,
        processedPayload: {
          ...geminiPayload,
          intRosterEmployee: matchedEmployee.Id,
          strComment: `Shift for ${matchedEmployee.DisplayName} (ID: ${matchedEmployee.Id}) - ${geminiPayload.strComment}`
        },
        debug: {
          extractedName: employeeName,
          employeesChecked: employees.length,
          wasEmployeeFound: true,
          matchedEmployeeId: matchedEmployee.Id
        }
      };
    } else {
      throw new Error('No employee name found in the schedule');
    }
  } catch (error) {
    throw error; // Re-throw the error to be handled by the calling function
  }
};

// Helper function to create a shift in Deputy
const createDeputyShift = async (shiftPayload, processedResult) => {
  try {
    const response = await axios.post(
      `${DEPUTY_BASE_URL}/api/v1/supervise/roster`,
      shiftPayload,
      {
        headers: {
          'Authorization': `Bearer ${DEPUTY_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );
    return {
      success: true,
      shiftId: response.data.Id,
      data: response.data
    };
  } catch (error) {
    // Extract error message with fallbacks
    const errorMessage = error.response?.data?.message || 
                        error.response?.data?.error?.message ||
                        error.response?.data?.error ||
                        `Error ${error.response?.status || 400}`;
    
    return {
      success: false,
      error: `Deputy API Error:\n\n${errorMessage} \n\n`,
      details: error.response?.data,
      shiftPayload
    };
  }
};

// Update the convertToUnixTimestamp function
const convertToUnixTimestamp = (dateStr, timeStr) => {
  try {
    const [day, month, year] = dateStr.split('-');
    const [time, period] = timeStr.split(' ');
    const [hours, minutes] = time.split(':');

    const months = {
      'jan': 0, 'feb': 1, 'mar': 2, 'apr': 3, 'may': 4, 'jun': 5,
      'jul': 6, 'aug': 7, 'sep': 8, 'oct': 9, 'nov': 10, 'dec': 11
    };

    let hour = parseInt(hours);
    if (period.toLowerCase() === 'pm' && hour !== 12) hour += 12;
    if (period.toLowerCase() === 'am' && hour === 12) hour = 0;

    // Create date directly in local time
    const date = new Date(
      2000 + parseInt(year),
      months[month.toLowerCase()],
      parseInt(day),
      hour,
      parseInt(minutes)
    );

    // Convert to Unix timestamp (seconds)
    return Math.floor(date.getTime() / 1000);
  } catch (error) {
    console.error('Error converting timestamp:', error);
    return null;
  }
};

// Update the prompt to request date and time separately
const prompt = `Analyze this image of a shift schedule and extract ALL shifts shown.
Return the shifts as a series of JSON objects, each containing:
{
  "date": "DD-MMM-YY",
  "startTime": "HH:MM AM/PM",
  "endTime": "HH:MM AM/PM",
  "intRosterEmployee": (employee name as string),
  "blnPublish": true,
  "intMealbreakMinute": 30,
  "intOpunitId": 1,
  "blnForceOverwrite": 0,
  "blnOpen": 0,
  "strComment": (include the actual date and times found),
  "intConfirmStatus": 1
}

Important:
- Extract ALL shifts shown in the image
- Include employee names exactly as shown
- Keep dates in DD-MMM-YY format (e.g., "1-Dec-24")
- Keep times in HH:MM AM/PM format (e.g., "9:00 AM")
- Include the original date and time in strComment
- Separate each shift with a comma
- DO NOT convert to timestamps - provide raw dates and times`;

app.post('/api/gemini/analyze-image', upload.single('image'), async (req, res) => {
  try {
    if (!GOOGLE_API_KEY) {
      return res.status(500).json({ message: 'Gemini API key not configured' });
    }

    if (!req.file) {
      return res.status(400).json({ message: 'No image file provided' });
    }

    const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);
    const model = genAI.getGenerativeModel({ 
      model: "gemini-1.5-flash",
      generationConfig: {
        temperature: 0.1,
        topP: 0.1,
        topK: 1,
      }
    });

    const imagePart = fileToGenerativePart(req.file.buffer, req.file.mimetype);

    const response = (await model.generateContent({
      contents: [{ role: "user", parts: [{ text: prompt }, imagePart] }],
    })).response;
    
    let text = response.text().trim();

    // Extract JSON if it's wrapped in backticks or other characters
    let jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      text = jsonMatch[0];
    }

    // Clean up common JSON issues
    text = text
      .replace(/^```json\s*/, '')
      .replace(/```$/, '')
      .replace(/^\s*`/, '')
      .replace(/`\s*$/, '')
      .replace(/\\n/g, '')
      .replace(/\n/g, ' ')
      .replace(/,\s*}/g, '}')
      .replace(/,\s*,/g, ',')
      .trim();

    // Wrap in array if needed
    if (text.startsWith('{')) {
      text = `[${text}]`;
    }

    // Fix multiple objects not in an array
    text = text.replace(/}\s*{/g, '},{');
    if (!text.startsWith('[')) {
      text = `[${text}]`;
    }

    try {
      let jsonResponse = JSON.parse(text);
      
      // Ensure jsonResponse is always an array
      if (!Array.isArray(jsonResponse)) {
        jsonResponse = [jsonResponse];
      }

      // Process each shift in the array
      const unprocessedShifts = [];
      const processedResults = [];

      // First, validate all shifts and check for missing employees
      for (const shift of jsonResponse) {
        try {
          const startTimestamp = convertToUnixTimestamp(shift.date, shift.startTime);
          const endTimestamp = convertToUnixTimestamp(shift.date, shift.endTime);

          const validatedShift = {
            intStartTimestamp: startTimestamp || Math.floor(Date.now() / 1000),
            intEndTimestamp: endTimestamp || (Math.floor(Date.now() / 1000) + 8 * 3600),
            intRosterEmployee: shift.intRosterEmployee || 1,
            blnPublish: true,
            intMealbreakMinute: parseInt(shift.intMealbreakMinute) || 30,
            intOpunitId: parseInt(shift.intOpunitId) || 1,
            blnForceOverwrite: 0,
            blnOpen: 0,
            strComment: `${shift.date} ${shift.startTime} to ${shift.endTime} - ${shift.strComment || "Shift extracted from image"}`,
            intConfirmStatus: 1
          };

          const processedResult = await processGeminiPayload(validatedShift);
          processedResults.push({ 
            processedResult,
            validatedShift
          });

        } catch (error) {
          unprocessedShifts.push({
            shift,
            error: error.message
          });
        }
      }

      if (unprocessedShifts.length > 0) {
        return res.status(400).json({
          error: 'Some employees need to be created in Deputy first',
          unprocessedShifts,
          processedShifts: processedResults
        });
      }

      const createdShifts = [];
      for (const result of processedResults) {
        const deputyResult = await createDeputyShift(
          result.processedResult.processedPayload, 
          result.processedResult
        );
        createdShifts.push({
          ...result,
          deputyResult
        });
      }

      res.json({ 
        response: {
          totalShifts: createdShifts.length,
          shifts: createdShifts.map(result => ({
            processedPayload: result.processedResult.processedPayload,
            deputyResult: result.deputyResult
          }))
        }
      });

    } catch (parseError) {
      res.status(200).json({
        response: {
          totalShifts: 0,
          successfulShifts: [],
          failedShifts: [{
            error: parseError.message,
            payload: null
          }]
        },
        debug: {
          error: parseError.message,
          originalText: text
        },
        warning: "Failed to parse AI response"
      });
    }
  } catch (error) {
    res.status(500).json({
      message: error.message,
      details: error.response?.data || 'No additional error details available'
    });
  }
});

app.post('/api/deputy/employees', async (req, res) => {
  try {
    const response = await axios.post(
      `${DEPUTY_BASE_URL}/api/v1/supervise/employee`,
      {
        strFirstName: req.body.FirstName,
        strLastName: req.body.LastName || "Doe",
        intCompanyId: 1,
        MainLocation: 1
      },
      {
        headers: {
          'Authorization': `Bearer ${DEPUTY_ACCESS_TOKEN}`,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );

    res.json({ success: true, employee: response.data });
  } catch (error) {
    res.status(error.response?.status || 500).json({
      success: false,
      message: 'Failed to create employee',
      details: error.response?.data || error.message
    });
  }
});

const PORT = process.env.PORT;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
}); 