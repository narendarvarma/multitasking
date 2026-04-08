class PersonalAssistant {
    constructor() {
        this.events = JSON.parse(localStorage.getItem('events') || '[]');
        this.reminders = JSON.parse(localStorage.getItem('reminders') || '[]');
        this.notes = JSON.parse(localStorage.getItem('notes') || '[]');
        this.useOllama = false;
        this.ollamaModel = 'llama2';
        this.conversationHistory = [];
        this.pendingEvent = null;
        this.pendingReminder = null;
        this.pendingNote = null;
        this.initializeApp();
    }

    initializeApp() {
        this.updateStats();
        this.renderAllTasks();
        this.checkReminders();
        setInterval(() => this.checkReminders(), 60000); // Check reminders every minute
        this.checkOllamaAvailability();
    }

    // Check if Ollama is available
    async checkOllamaAvailability() {
        try {
            const response = await fetch('http://localhost:11434/api/tags');
            if (response.ok) {
                this.useOllama = true;
                console.log('Ollama is available');
            }
        } catch (error) {
            console.log('Ollama not available, using built-in NLP');
            this.useOllama = false;
        }
    }

    // Process message with Ollama or built-in NLP
    async processMessage(message) {
        if (this.useOllama) {
            return await this.processWithOllama(message);
        } else {
            return this.processWithBuiltInNLP(message);
        }
    }

    // Process with Ollama local LLM
    async processWithOllama(message) {
        try {
            const prompt = `You are a personal assistant that manages calendar events, reminders, and notes. 
            Analyze the user's message and respond with a JSON object containing the appropriate action.
            
            Rules:
            - If message contains date/time + event: create_event
            - If message contains "remind" + time: set_reminder  
            - If message contains "note"/"remember": save_note
            - Otherwise: ask_question
            
            User message: "${message}"
            
            Respond with JSON only, no extra text.`;

            const response = await fetch('http://localhost:11434/api/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: this.ollamaModel,
                    prompt: prompt,
                    stream: false
                })
            });

            const data = await response.json();
            const llmResponse = data.response.trim();
            
            // Try to parse JSON from LLM response
            try {
                const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
                if (jsonMatch) {
                    const action = JSON.parse(jsonMatch[0]);
                    return this.executeAction(action, message);
                }
            } catch (parseError) {
                console.log('Failed to parse LLM JSON response');
            }
            
            // Fallback to built-in NLP
            return this.processWithBuiltInNLP(message);
            
        } catch (error) {
            console.log('Ollama error, falling back to built-in NLP');
            return this.processWithBuiltInNLP(message);
        }
    }

    // Built-in NLP processing with context awareness
    processWithBuiltInNLP(message) {
        const lowerMessage = message.toLowerCase();
        
        // Add to conversation history
        this.addToHistory('user', message);
        
        // Check if this is a follow-up response to a previous question
        const followUpResponse = this.handleFollowUp(message);
        if (followUpResponse) {
            return followUpResponse;
        }
        
        // Priority-based detection with context awareness
        
        // 1. Check for explicit reminder intent (highest priority for time-specific tasks)
        if (this.detectReminderIntent(lowerMessage)) {
            return this.createReminder(message);
        }
        
        // 2. Check for temporal references - could be event or reminder
        if (this.detectCalendarIntent(lowerMessage)) {
            // If there's a time reference, it might be a reminder
            if (this.extractTime(message).time) {
                // Check if it sounds more like a reminder or event
                const reminderWords = ['remind', 'reminder', 'wake', 'alert', 'notify', 'don\'t forget', 'remember to'];
                const hasReminderWords = reminderWords.some(word => lowerMessage.includes(word));
                
                if (hasReminderWords) {
                    return this.createReminder(message);
                } else {
                    return this.createCalendarEvent(message);
                }
            } else {
                // No specific time, treat as event
                return this.createCalendarEvent(message);
            }
        }
        
        // 3. Check for note intent (information storage)
        if (this.detectNoteIntent(lowerMessage)) {
            return this.createNote(message);
        }
        
        // 4. Fallback - try to be helpful based on content analysis
        const contentAnalysis = this.analyzeContent(message);
        if (contentAnalysis.suggestion) {
            return contentAnalysis.suggestion;
        }
        
        // 5. If still unclear, ask for clarification
        return {
            action: "ask_question",
            question: "I'm not sure what you want to do. Could you clarify if you want to:\n- Schedule an event/appointment\n- Set a reminder\n- Save a note"
        };
    }
    
    addToHistory(role, content) {
        this.conversationHistory.push({
            role: role,
            content: content,
            timestamp: new Date().toISOString()
        });
        
        // Keep only last 10 messages to avoid memory issues
        if (this.conversationHistory.length > 10) {
            this.conversationHistory = this.conversationHistory.slice(-10);
        }
    }
    
    handleFollowUp(message) {
        // Get the last assistant message to see if we asked a question
        const lastAssistantMessage = this.conversationHistory
            .reverse()
            .find(msg => msg.role === 'assistant');
        
        if (lastAssistantMessage && lastAssistantMessage.action) {
            const lastAction = lastAssistantMessage.action;
            
            // Handle responses to different types of questions
            if (lastAction.action === 'ask_question') {
                return this.handleQuestionResponse(message, lastAction);
            }
        }
        
        return null;
    }
    
    handleQuestionResponse(message, lastAction) {
        const lowerMessage = message.toLowerCase();
        
        // If we asked for date/time and user provides it
        if (lastAction.question.includes('when') || lastAction.question.includes('date') || lastAction.question.includes('time')) {
            // Try to extract date/time from response
            const dateInfo = this.extractDate(message);
            const timeInfo = this.extractTime(message);
            
            if (dateInfo.date || timeInfo.time) {
                // Complete the pending action
                if (this.pendingEvent) {
                    const event = {
                        ...this.pendingEvent,
                        date: dateInfo.date || this.pendingEvent.date,
                        time: timeInfo.time || this.pendingEvent.time,
                        displayDate: dateInfo.displayDate || this.pendingEvent.displayDate,
                        displayTime: timeInfo.displayTime || this.pendingEvent.displayTime
                    };
                    
                    this.events.push(event);
                    this.saveToLocalStorage();
                    this.updateStats();
                    this.renderAllTasks();
                    this.pendingEvent = null;
                    
                    return {
                        action: "create_event",
                        title: event.title,
                        date: event.displayDate,
                        time: event.time,
                        reminder: event.reminder
                    };
                }
            }
        }
        
        return null;
    }
    
    analyzeContent(message) {
        const lowerMessage = message.toLowerCase();
        
        // Look for any mention of future plans or activities
        const planningWords = ['plan', 'going to', 'will', 'want to', 'need to', 'have to', 'should'];
        const hasPlanning = planningWords.some(word => lowerMessage.includes(word));
        
        // Look for information storage patterns
        const infoWords = ['remember', 'don\'t forget', 'important', 'note', 'save', 'keep track'];
        const hasInfo = infoWords.some(word => lowerMessage.includes(word));
        
        // Look for time sensitivity
        const timeWords = ['today', 'tomorrow', 'tonight', 'am', 'pm', 'o\'clock'];
        const hasTime = timeWords.some(word => lowerMessage.includes(word));
        
        if (hasTime && hasPlanning) {
            return {
                suggestion: {
                    action: "ask_question",
                    question: "It sounds like you're planning something for a specific time. Should I create a calendar event or set a reminder?"
                }
            };
        }
        
        if (hasInfo && !hasTime) {
            return {
                suggestion: this.createNote(message)
            };
        }
        
        if (hasPlanning && !hasTime) {
            // If there's planning but no time, it's likely an event, ask for time
            return {
                suggestion: {
                    action: "ask_question",
                    question: "It sounds like you're planning something. When should I schedule this?"
                }
            };
        }

        // New rule: If a common event keyword is present, suggest creating an event
        const eventKeywords = ['birthday', 'anniversary', 'wedding', 'party', 'celebration', 'gathering', 'vacation', 'trip', 'holiday', 'festival', 'concert', 'meeting', 'appointment', 'interview', 'conference', 'workshop', 'exam', 'test', 'presentation'];
        const hasEventKeyword = eventKeywords.some(word => lowerMessage.includes(word));

        if (hasEventKeyword && !hasTime) {
            const matchedKeyword = eventKeywords.find(word => lowerMessage.includes(word));
            return {
                suggestion: {
                    action: "ask_question",
                    question: `It sounds like you're referring to a ${matchedKeyword}. When is it?`
                }
            };
        }
        
        return { suggestion: null };
    }

    // Execute the action determined by NLP/LLM
    executeAction(action, originalMessage) {
        switch(action.action) {
            case 'create_event':
                return this.createCalendarEvent(originalMessage);
            case 'set_reminder':
                return this.createReminder(originalMessage);
            case 'save_note':
                return this.createNote(originalMessage);
            case 'ask_question':
                return action;
            default:
                return {
                    action: "ask_question",
                    question: "I didn't understand that. Could you please clarify?"
                };
        }
    }

    detectCalendarIntent(message) {
        // More flexible detection - look for any temporal reference + activity
        const temporalPatterns = [
            /\b(today|tomorrow|yesterday|tonight|tonite)\b/i,
            /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i,
            /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i,
            /\b\d{1,2}(?:st|nd|rd|th)\b/i,
            /\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/i,
            /\b\d{1,2}:\d{2}\s*(?:am|pm)\b/i,
            /\b\d{1,2}\s*(?:am|pm)\b/i,
            /\b(next|last|this)\s+week\b/i,
            /\b(next|last|this)\s+month\b/i,
            /\b(in\s+\d+\s+(?:day|week|month|hour|minute)s?)\b/i,
            /\b(on|at|for|during)\s+(\d+|today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i
        ];
        
        // Check if message contains any temporal reference
        const hasTemporal = temporalPatterns.some(pattern => pattern.test(message));
        
        // If there's a temporal reference, treat it as a potential event
        // We'll extract the actual activity/title later
        return hasTemporal;
    }

    detectReminderIntent(message) {
        const reminderKeywords = [
            'remind', 'reminder', 'wake', 'alert', 'notify', 'don\'t forget',
            'remember to', 'make sure', 'call me', 'text me', 'send me'
        ];
        
        return reminderKeywords.some(keyword => message.includes(keyword));
    }

    detectNoteIntent(message) {
        const noteKeywords = [
            'note', 'remember', 'save', 'write down', 'record', 'document',
            'idea', 'thought', 'memo', 'journal', 'diary'
        ];
        
        return noteKeywords.some(keyword => message.includes(keyword)) ||
               message.startsWith('note this') ||
               message.startsWith('remember that') ||
               message.startsWith('save this');
    }

    // Calendar Event Creation
    createCalendarEvent(message) {
        const dateInfo = this.extractDate(message);
        const timeInfo = this.extractTime(message);
        const title = this.extractEventTitle(message);
        
        if (!dateInfo.date) {
            // Store pending event for follow-up
            this.pendingEvent = {
                id: Date.now(),
                title: title,
                date: dateInfo.date,
                time: timeInfo.time || "09:00 AM",
                reminder: "1 hour before",
                createdAt: new Date().toISOString()
            };
            
            return {
                action: "ask_question",
                question: `When is your "${title}" event? Please provide a specific date.`
            };
        }
        
        const event = {
            id: Date.now(),
            title: title,
            date: dateInfo.date,
            time: timeInfo.time || "09:00 AM",
            reminder: "1 hour before",
            createdAt: new Date().toISOString()
        };
        
        this.events.push(event);
        this.saveToLocalStorage();
        this.updateStats();
        this.renderAllTasks();
        
        return {
            action: "create_event",
            title: title,
            date: dateInfo.displayDate,
            time: event.time,
            reminder: event.reminder
        };
    }

    extractDate(message) {
        const today = new Date();
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);
        
        // Handle "tomorrow"
        if (message.toLowerCase().includes('tomorrow')) {
            return {
                date: tomorrow.toISOString().split('T')[0],
                displayDate: 'Tomorrow'
            };
        }
        
        // Handle "today"
        if (message.toLowerCase().includes('today')) {
            return {
                date: today.toISOString().split('T')[0],
                displayDate: 'Today'
            };
        }
        
        // Extract date numbers (e.g., "20th", "15th", "December 25th")
        const dateMatch = message.match(/(\d{1,2})(?:st|nd|rd|th)/);
        if (dateMatch) {
            const day = parseInt(dateMatch[1]);
            const date = new Date(today.getFullYear(), today.getMonth(), day);
            
            // If the date is in the past, assume next month
            if (date < today) {
                date.setMonth(date.getMonth() + 1);
            }
            
            return {
                date: date.toISOString().split('T')[0],
                displayDate: date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
            };
        }
        
        return { date: null, displayDate: null };
    }

    extractTime(message) {
        const timeMatch = message.match(/(\d{1,2}):(\d{2})\s*(am|pm)?/i) ||
                         message.match(/(\d{1,2})\s*(am|pm)/i);
        
        if (timeMatch) {
            let hours = parseInt(timeMatch[1]);
            const minutes = timeMatch[2] ? parseInt(timeMatch[2]) : 0;
            const period = timeMatch[3] || (message.includes('pm') ? 'pm' : 'am');
            
            if (period === 'pm' && hours !== 12) hours += 12;
            if (period === 'am' && hours === 12) hours = 0;
            
            const time = `${hours.toString().padStart(2, '0')}:${minutes.toString().padStart(2, '0')}`;
            const displayTime = `${hours > 12 ? hours - 12 : hours}:${minutes.toString().padStart(2, '0')} ${period.toUpperCase()}`;
            
            return { time, displayTime };
        }
        
        return { time: null, displayTime: null };
    }

    extractEventTitle(message) {
        // Remove temporal patterns but keep the actual activity/event description
        let title = message
            // Remove specific date/time patterns
            .replace(/\b\d{1,2}(?:st|nd|rd|th)\b/gi, '')
            .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/gi, '')
            .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, '')
            .replace(/\b\d{1,2}[/-]\d{1,2}(?:[/-]\d{2,4})?\b/g, '')
            // Remove temporal keywords but keep context
            .replace(/\b(today|tomorrow|yesterday|tonight|tonite)\b/gi, '')
            .replace(/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gi, '')
            .replace(/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/gi, '')
            // Remove prepositions and filler words
            .replace(/\b(on|at|in|for|during|with|to|from|by|the|a|an)\b/gi, '')
            // Remove reminder/note keywords
            .replace(/\b(remind|reminder|note|remember|save|write)\b/gi, '')
            .trim();
        
        // Clean up extra spaces and capitalize properly
        title = title.replace(/\s+/g, ' ').trim();
        
        // If title is too long, truncate it but keep meaningful words
        if (title.length > 50) {
            const words = title.split(' ');
            title = words.slice(0, 6).join(' ') + '...';
        }
        
        // If no meaningful content extracted, use a generic title
        if (!title || title.length < 2) {
            return 'Event';
        }
        
        // Capitalize first letter of each word
        return title.split(' ').map(word => 
            word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
        ).join(' ');
    }

    // Reminder Creation
    createReminder(message) {
        const timeInfo = this.extractTime(message);
        const task = this.extractReminderTask(message);
        
        if (!timeInfo.time) {
            return {
                action: "ask_question",
                question: "What time should I remind you?"
            };
        }
        
        const reminder = {
            id: Date.now(),
            task: task,
            time: timeInfo.time,
            displayTime: timeInfo.displayTime,
            createdAt: new Date().toISOString(),
            triggered: false
        };
        
        this.reminders.push(reminder);
        this.saveToLocalStorage();
        this.updateStats();
        this.renderAllTasks();
        
        return {
            action: "set_reminder",
            task: task,
            time: timeInfo.displayTime
        };
    }

    extractReminderTask(message) {
        // Remove time patterns and reminder keywords, but keep the actual task
        let task = message
            .replace(/\b\d{1,2}:\d{2}\s*(?:am|pm)\b/gi, '')
            .replace(/\b\d{1,2}\s*(?:am|pm)\b/gi, '')
            .replace(/\b(remind|reminder|wake|alert|notify|don't forget)\s+me\s+(to)?\b/gi, '')
            .replace(/\b(at|on|in|for)\b/gi, '')
            .trim();
        
        // Clean up and format the task
        task = task.replace(/\s+/g, ' ').trim();
        
        // If task is too long, truncate it meaningfully
        if (task.length > 40) {
            const words = task.split(' ');
            task = words.slice(0, 5).join(' ') + '...';
        }
        
        // Capitalize properly
        if (task) {
            task = task.charAt(0).toUpperCase() + task.slice(1).toLowerCase();
        }
        
        return task || 'Reminder';
    }

    // Note Creation
    createNote(message) {
        const content = this.extractNoteContent(message);
        const timestamp = new Date().toLocaleString('en-US', {
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        
        const note = {
            id: Date.now(),
            content: content,
            timestamp: timestamp,
            createdAt: new Date().toISOString()
        };
        
        this.notes.push(note);
        this.saveToLocalStorage();
        this.updateStats();
        this.renderAllTasks();
        
        return {
            action: "save_note",
            content: content,
            timestamp: timestamp
        };
    }

    extractNoteContent(message) {
        // Remove note-taking keywords but preserve the actual content
        let content = message
            .replace(/\b(note|remember|save|write|record|document)\s+(this|that|the|these|those)?\b/gi, '')
            .replace(/\b(idea|thought|memo|journal|diary)\b/gi, '')
            .replace(/\b(please|can you|could you)\b/gi, '')
            .trim();
        
        // Clean up spacing
        content = content.replace(/\s+/g, ' ').trim();
        
        // If no content after cleaning, use original message
        return content || message;
    }

    // Storage and Rendering
    saveToLocalStorage() {
        localStorage.setItem('events', JSON.stringify(this.events));
        localStorage.setItem('reminders', JSON.stringify(this.reminders));
        localStorage.setItem('notes', JSON.stringify(this.notes));
    }

    updateStats() {
        document.getElementById('eventCount').textContent = this.events.length;
        document.getElementById('reminderCount').textContent = this.reminders.length;
        document.getElementById('noteCount').textContent = this.notes.length;
    }

    renderAllTasks() {
        this.renderRecentTasks();
        this.renderAllTasksList();
    }

    renderRecentTasks() {
        const container = document.getElementById('recentTasks');
        if (!container) {
            console.log('recentTasks container not found, trying tasksContainer');
            return;
        }
        const allTasks = [
            ...this.events.map(e => ({...e, type: 'event', icon: 'fa-calendar', color: 'blue'})),
            ...this.reminders.map(r => ({...r, type: 'reminder', icon: 'fa-bell', color: 'green'})),
            ...this.notes.map(n => ({...n, type: 'note', icon: 'fa-sticky-note', color: 'yellow'}))
        ];
        
        if (allTasks.length === 0) {
            container.innerHTML = '<p class="text-gray-500 text-sm">No activity yet</p>';
            return;
        }
        
        const recent = allTasks
            .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
            .slice(0, 5);
        
        container.innerHTML = recent.map(task => `
            <div class="flex items-start space-x-2 p-2 bg-gray-50 rounded hover:bg-gray-100 transition-colors cursor-pointer" onclick="assistant.showTaskDetails('${task.type}', ${task.id})">
                <i class="fas ${task.icon} text-${task.color}-600 text-sm mt-1"></i>
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-gray-800 truncate">
                        ${task.title || task.task || task.content.substring(0, 30) + (task.content && task.content.length > 30 ? '...' : '')}
                    </p>
                    <p class="text-xs text-gray-500">${task.type.charAt(0).toUpperCase() + task.type.slice(1)}</p>
                </div>
                <button onclick="event.stopPropagation(); assistant.deleteTask('${task.type}', ${task.id})" class="text-red-500 hover:text-red-700 opacity-0 hover:opacity-100 transition-opacity">
                    <i class="fas fa-trash text-xs"></i>
                </button>
            </div>
        `).join('');
    }

    renderAllTasksList() {
        const container = document.getElementById('tasksContainer');
        if (!container) {
            console.log('tasksContainer not found');
            return;
        }

        const allTasks = [
            ...this.events.map(e => ({...e, type: 'event', icon: 'fa-calendar', color: 'blue'})),
            ...this.reminders.map(r => ({...r, type: 'reminder', icon: 'fa-bell', color: 'green'})),
            ...this.notes.map(n => ({...n, type: 'note', icon: 'fa-sticky-note', color: 'yellow'}))
        ];
        
        if (allTasks.length === 0) {
            container.innerHTML = `
                <div class="text-center py-8">
                    <i class="fas fa-clipboard-list text-4xl text-gray-300 mb-4"></i>
                    <p class="text-gray-500">No tasks yet. Start by creating an event, reminder, or note!</p>
                </div>
            `;
            return;
        }

        // Group tasks by type
        const events = allTasks.filter(task => task.type === 'event');
        const reminders = allTasks.filter(task => task.type === 'reminder');
        const notes = allTasks.filter(task => task.type === 'note');

        // Sort each group by date
        events.sort((a, b) => new Date(a.date || a.createdAt) - new Date(b.date || b.createdAt));
        reminders.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
        notes.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));

        let html = '';
        
        // Events section
        if (events.length > 0) {
            html += `
                <div class="mb-6">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-gray-800 flex items-center">
                            <i class="fas fa-calendar text-blue-500 mr-2"></i>
                            Events (${events.length})
                        </h3>
                    </div>
                    <div class="space-y-3">
                        ${events.map(task => this.createTaskCard(task)).join('')}
                    </div>
                </div>
            `;
        }

        // Reminders section
        if (reminders.length > 0) {
            html += `
                <div class="mb-6">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-gray-800 flex items-center">
                            <i class="fas fa-bell text-green-500 mr-2"></i>
                            Reminders (${reminders.length})
                        </h3>
                    </div>
                    <div class="space-y-3">
                        ${reminders.map(task => this.createTaskCard(task)).join('')}
                    </div>
                </div>
            `;
        }

        // Notes section
        if (notes.length > 0) {
            html += `
                <div class="mb-6">
                    <div class="flex items-center justify-between mb-3">
                        <h3 class="text-lg font-semibold text-gray-800 flex items-center">
                            <i class="fas fa-sticky-note text-yellow-500 mr-2"></i>
                            Notes (${notes.length})
                        </h3>
                    </div>
                    <div class="space-y-3">
                        ${notes.map(task => this.createTaskCard(task)).join('')}
                    </div>
                </div>
            `;
        }

        container.innerHTML = html;
    }

    createTaskCard(task) {
        let taskInfo = '';
        let dateInfo = '';

        if (task.type === 'event') {
            taskInfo = task.title || 'Event';
            dateInfo = task.date ? new Date(task.date).toLocaleDateString() : '';
            if (task.time) dateInfo += ` at ${task.time}`;
        } else if (task.type === 'reminder') {
            taskInfo = task.task || 'Reminder';
            dateInfo = task.displayTime || task.time || '';
        } else if (task.type === 'note') {
            taskInfo = task.content || 'Note';
            dateInfo = task.timestamp || new Date(task.createdAt).toLocaleDateString();
        }

        return `
            <div class="task-card ${task.type}" onclick="assistant.showTaskDetails('${task.type}', ${task.id})">
                <div class="flex items-start justify-between">
                    <div class="flex items-start space-x-3 flex-1">
                        <div class="task-type-icon ${task.type}-icon">
                            <i class="fas ${task.icon}"></i>
                        </div>
                        <div class="flex-1">
                            <h4 class="font-medium text-gray-800 mb-1">${taskInfo}</h4>
                            ${dateInfo ? `<p class="text-sm text-gray-500">${dateInfo}</p>` : ''}
                        </div>
                    </div>
                    <button onclick="event.stopPropagation(); assistant.deleteTask('${task.type}', ${task.id})" 
                            class="text-red-400 hover:text-red-600 transition-colors p-2">
                        <i class="fas fa-trash"></i>
                    </button>
                </div>
            </div>
        `;
    }

    deleteTask(type, id) {
        if (type === 'event') {
            this.events = this.events.filter(e => e.id !== id);
        } else if (type === 'reminder') {
            this.reminders = this.reminders.filter(r => r.id !== id);
        } else if (type === 'note') {
            this.notes = this.notes.filter(n => n.id !== id);
        }
        
        this.saveToLocalStorage();
        this.updateStats();
        this.renderAllTasks();
        this.addMessage('system', `${type.charAt(0).toUpperCase() + type.slice(1)} deleted successfully.`);
    }

    showTaskDetails(type, id) {
        let task;
        if (type === 'event') {
            task = this.events.find(e => e.id === id);
        } else if (type === 'reminder') {
            task = this.reminders.find(r => r.id === id);
        } else if (type === 'note') {
            task = this.notes.find(n => n.id === id);
        }
        
        if (task) {
            let details = '';
            if (type === 'event') {
                details = `Event: ${task.title}\nDate: ${task.date}\nTime: ${task.time}\nReminder: ${task.reminder}`;
            } else if (type === 'reminder') {
                details = `Reminder: ${task.task}\nTime: ${task.displayTime}`;
            } else if (type === 'note') {
                details = `Note: ${task.content}\nCreated: ${task.timestamp}`;
            }
            this.addMessage('system', details);
        }
    }

    checkReminders() {
        const now = new Date();
        const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;
        
        this.reminders.forEach(reminder => {
            if (!reminder.triggered && reminder.time === currentTime) {
                this.triggerReminder(reminder);
                reminder.triggered = true;
                this.saveToLocalStorage();
            }
        });
    }

    triggerReminder(reminder) {
        // Create a browser notification
        if ('Notification' in window && Notification.permission === 'granted') {
            new Notification('Reminder', {
                body: reminder.task,
                icon: 'https://cdn-icons-png.flaticon.com/512/1827/1827422.png'
            });
        }
        
        // Show in chat
        this.addMessage('system', `Reminder: ${reminder.task}`, 'reminder');
    }

    addMessage(type, content, actionType = null) {
        const chatMessages = document.getElementById('chatMessages');
        const messageDiv = document.createElement('div');
        messageDiv.className = 'message-bubble mb-4';
        
        if (type === 'user') {
            messageDiv.innerHTML = `
                <div class="flex items-start space-x-2 justify-end">
                    <div class="bg-indigo-600 text-white p-3 rounded-lg shadow-sm max-w-xs lg:max-w-md">
                        <p>${content}</p>
                    </div>
                    <div class="bg-indigo-100 rounded-full p-2">
                        <i class="fas fa-user text-indigo-600 text-sm"></i>
                    </div>
                </div>
            `;
        } else if (type === 'assistant') {
            let messageContent = '';
            let actionData = null;
            
            if (typeof content === 'string') {
                messageContent = content;
            } else {
                // Convert JSON action to user-friendly message
                messageContent = this.formatActionMessage(content);
                actionData = content;
            }
            
            messageDiv.innerHTML = `
                <div class="flex items-start space-x-2">
                    <div class="bg-indigo-600 rounded-full p-2">
                        <i class="fas fa-robot text-white text-sm"></i>
                    </div>
                    <div class="bg-white p-3 rounded-lg shadow-sm flex-1">
                        <p class="text-gray-800">${messageContent}</p>
                    </div>
                </div>
            `;
            
            // Add to conversation history with action data
            this.addToHistory('assistant', messageContent, actionData);
        } else if (type === 'system') {
            messageDiv.innerHTML = `
                <div class="flex items-start space-x-2">
                    <div class="bg-yellow-500 rounded-full p-2">
                        <i class="fas fa-exclamation text-white text-sm"></i>
                    </div>
                    <div class="bg-yellow-50 p-3 rounded-lg shadow-sm flex-1">
                        <p class="text-yellow-800">${content}</p>
                    </div>
                </div>
            `;
        }
        
        chatMessages.appendChild(messageDiv);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }
    
    addToHistory(role, content, actionData = null) {
        this.conversationHistory.push({
            role: role,
            content: content,
            action: actionData,
            timestamp: new Date().toISOString()
        });
        
        // Keep only last 10 messages to avoid memory issues
        if (this.conversationHistory.length > 10) {
            this.conversationHistory = this.conversationHistory.slice(-10);
        }
    }

    formatActionMessage(action) {
        switch(action.action) {
            case 'create_event':
                return `Event created: "${action.title}" on ${action.date} at ${action.time} with ${action.reminder} reminder.`;
            case 'set_reminder':
                return `Reminder set: "${action.task}" at ${action.time}.`;
            case 'save_note':
                return `Note saved: "${action.content}" at ${action.timestamp}.`;
            case 'ask_question':
                return action.question;
            default:
                return `Action completed: ${JSON.stringify(action)}`;
        }
    }

    clearAllData() {
        if (confirm('Are you sure you want to clear all data? This cannot be undone.')) {
            this.events = [];
            this.reminders = [];
            this.notes = [];
            this.saveToLocalStorage();
            this.updateStats();
            this.renderAllTasks();
            this.addMessage('system', 'All data has been cleared.');
        }
    }

    exportData() {
        const data = {
            events: this.events,
            reminders: this.reminders,
            notes: this.notes,
            exportDate: new Date().toISOString()
        };
        
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `personal-assistant-data-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
    }
}

// Initialize the assistant
let assistant;

// Request notification permission
if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
}

// Global functions
function sendMessage() {
    const input = document.getElementById('userInput');
    const message = input.value.trim();
    
    if (!message) return;
    
    // Ensure assistant is initialized
    if (!window.assistant) {
        console.error('Assistant not initialized');
        return;
    }
    
    // Add user message to chat
    window.assistant.addMessage('user', message);
    
    // Show typing indicator
    const chatMessages = document.getElementById('chatMessages');
    const typingDiv = document.createElement('div');
    typingDiv.id = 'typingIndicator';
    typingDiv.className = 'message-bubble mb-4';
    typingDiv.innerHTML = `
        <div class="flex items-start space-x-2">
            <div class="bg-indigo-600 rounded-full p-2">
                <i class="fas fa-robot text-white text-sm"></i>
            </div>
            <div class="bg-white p-3 rounded-lg shadow-sm">
                <div class="typing-indicator">
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                    <div class="typing-dot"></div>
                </div>
            </div>
        </div>
    `;
    chatMessages.appendChild(typingDiv);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    
    // Process message (async for Ollama support)
    window.assistant.processMessage(message).then(response => {
        // Remove typing indicator
        const indicator = document.getElementById('typingIndicator');
        if (indicator) indicator.remove();
        
        // Add assistant response
        window.assistant.addMessage('assistant', response);
        
        // Update calendar after any event creation
        if (response.action === 'create_event') {
            setTimeout(() => {
                if (typeof renderCalendar === 'function') {
                    renderCalendar();
                }
            }, 100);
        }
        
        // Clear input
        input.value = '';
    }).catch(error => {
        console.error('Error processing message:', error);
        // Remove typing indicator
        const indicator = document.getElementById('typingIndicator');
        if (indicator) indicator.remove();
        
        // Add error message
        window.assistant.addMessage('assistant', 'Sorry, I encountered an error. Please try again.');
        input.value = '';
    });
}

function clearAllData() {
    assistant.clearAllData();
}

function exportData() {
    assistant.exportData();
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('Initializing assistant...');
    window.assistant = new PersonalAssistant();
    console.log('Assistant initialized:', window.assistant);
    
    // Make assistant globally accessible
    window.sendMessage = sendMessage;
    
    // Update calendar when events change
    const originalCreateCalendarEvent = window.assistant.createCalendarEvent.bind(window.assistant);
    window.assistant.createCalendarEvent = function(message) {
        const result = originalCreateCalendarEvent(message);
        console.log('Event created:', result);
        // Update calendar after event creation
        setTimeout(() => {
            if (typeof renderCalendar === 'function') {
                renderCalendar();
            }
        }, 100);
        return result;
    };
    
    // Also update calendar when reminders are created with dates
    const originalCreateReminder = window.assistant.createReminder.bind(window.assistant);
    window.assistant.createReminder = function(message) {
        const result = originalCreateReminder(message);
        console.log('Reminder created:', result);
        // Update calendar after reminder creation
        setTimeout(() => {
            if (typeof renderCalendar === 'function') {
                renderCalendar();
            }
        }, 100);
        return result;
    };
});
